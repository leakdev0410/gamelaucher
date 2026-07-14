import { downloadsSublevel, gamesSublevel, levelKeys, db } from "@main/level";
import { Downloader } from "@shared";
import type { Download, Game } from "@types";
import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DownloadManager } from "./download/download-manager";
import { GameFilesManager } from "./game-files-manager";
import { logger } from "./logger";
import { WindowManager } from "./window-manager";

/** Max automatic extract attempts before asking the user whether to continue. */
const ATTEMPTS_PER_BATCH = 10;

/** How long to wait between release_files calls while probing locks. */
const TORRENT_RELEASE_ATTEMPTS = 12;
const TORRENT_RELEASE_SETTLE_BASE_MS = 1_500;
const TORRENT_RELEASE_SETTLE_MAX_MS = 8_000;

/** Exclusive-open / rename probe retries for a single archive path. */
const FILE_READINESS_POLL_MS = 750;
const FILE_READINESS_MAX_ATTEMPTS = 16;

/** Backoff after a failed full extract attempt (before the next prepare+extract). */
const EXTRACT_RETRY_BACKOFF_BASE_MS = 2_000;
const EXTRACT_RETRY_BACKOFF_MAX_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isLockRelatedError = (error: unknown): boolean => {
  const text = (
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error ?? "")
  ).toLowerCase();

  return (
    text.includes("locked") ||
    text.includes("ebusy") ||
    text.includes("eperm") ||
    text.includes("eacces") ||
    text.includes("being used by another process") ||
    text.includes("cannot access the file") ||
    text.includes("process cannot access") ||
    text.includes("resource busy") ||
    text.includes("used by another")
  );
};

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
};

export class ExtractionCoordinator {
  /** In-memory set of game keys currently inside the extract loop (blocks re-seed). */
  private static readonly activeExtractionKeys = new Set<string>();

  static isExtractionInProgress(shop: Game["shop"], objectId: string) {
    return this.activeExtractionKeys.has(levelKeys.game(shop, objectId));
  }

  static shouldResumeSeedingAfterExtraction(download: Download) {
    return (
      download.downloader === Downloader.Torrent &&
      download.shouldSeed &&
      download.uri !== null &&
      (download.status === "seeding" || download.progress === 1)
    );
  }

  /**
   * Run extraction with aggressive torrent-handle release, lock probing, and
   * unlimited batch retries (user is prompted every {@link ATTEMPTS_PER_BATCH} failures).
   * Seeding is only restored after a successful extract so handles stay dropped while retrying.
   */
  static async run(download: Download, game: Game) {
    const gameKey = levelKeys.game(game.shop, game.objectId);
    const shouldResumeSeeding =
      this.shouldResumeSeedingAfterExtraction(download);
    const gameFilesManager = new GameFilesManager(game.shop, game.objectId);

    let totalAttempts = 0;
    let lastError: unknown;

    this.activeExtractionKeys.add(gameKey);

    // Always mark extracting up-front (startup bootstrap may have cleared the flag).
    await this.ensureExtractingFlag(download, true);

    try {
      while (true) {
        for (
          let batchAttempt = 0;
          batchAttempt < ATTEMPTS_PER_BATCH;
          batchAttempt++
        ) {
          totalAttempts++;

          try {
            await this.prepare(download, totalAttempts);

            const settleMs = Math.min(
              EXTRACT_RETRY_BACKOFF_BASE_MS * batchAttempt,
              EXTRACT_RETRY_BACKOFF_MAX_MS
            );
            if (settleMs > 0) {
              await sleep(settleMs);
            }

            await DownloadManager.handleExtraction(download, game);

            logger.info(
              `[ExtractionCoordinator] Extraction succeeded for ${game.objectId} after ${totalAttempts} attempt(s)`
            );

            this.activeExtractionKeys.delete(gameKey);

            if (shouldResumeSeeding) {
              await DownloadManager.resumeSeeding(download).catch(
                (resumeError) => {
                  logger.error(
                    "[ExtractionCoordinator] Failed to resume seeding after successful extraction",
                    resumeError
                  );
                }
              );
            }

            return;
          } catch (error) {
            lastError = error;
            logger.warn(
              `[ExtractionCoordinator] Extract attempt ${totalAttempts} failed for ${game.objectId}`,
              error
            );

            // Keep UI in "extracting" state across retries.
            await this.ensureExtractingFlag(download, true);

            if (download.downloader === Downloader.Torrent) {
              await DownloadManager.releaseTorrentFiles(download).catch(
                (releaseError) => {
                  logger.warn(
                    "[ExtractionCoordinator] Re-release after failed attempt",
                    releaseError
                  );
                }
              );
            }

            const backoffMs = Math.min(
              EXTRACT_RETRY_BACKOFF_BASE_MS *
                Math.pow(1.5, Math.min(batchAttempt, 6)),
              EXTRACT_RETRY_BACKOFF_MAX_MS
            );
            // Lock errors get a longer pause so Windows / torrent can drop handles.
            await sleep(
              isLockRelatedError(error)
                ? Math.max(backoffMs, 4_000)
                : backoffMs
            );
          }
        }

        const shouldContinue = await this.promptContinueExtraction(
          game,
          totalAttempts,
          lastError
        );

        if (!shouldContinue) {
          await gameFilesManager.failExtraction(
            lastError ??
              new Error(
                `Extraction failed after ${totalAttempts} attempt(s)`
              )
          );
          throw (
            lastError ??
            new Error(`Extraction failed after ${totalAttempts} attempt(s)`)
          );
        }

        logger.info(
          `[ExtractionCoordinator] User chose to continue extraction for ${game.objectId} after ${totalAttempts} attempt(s)`
        );

        // Extra safety drop before the next batch.
        if (download.downloader === Downloader.Torrent) {
          await DownloadManager.releaseTorrentFiles(download).catch(() => {
            /* logged inside */
          });
          await sleep(TORRENT_RELEASE_SETTLE_BASE_MS);
        }
      }
    } catch (error) {
      // failExtraction already called when user stops; ensure state on unexpected throw.
      const downloadState = await downloadsSublevel.get(gameKey);
      if (downloadState?.extracting) {
        await gameFilesManager.failExtraction(error).catch((failError) => {
          logger.error(
            "[ExtractionCoordinator] Failed to persist extraction failure state",
            failError
          );
        });
      }
      throw error;
    } finally {
      this.activeExtractionKeys.delete(gameKey);
    }
    // Intentionally no finally-resume: seeding must not re-lock archives while
    // extraction is still failing or the user aborted.
  }

  static async runByKey(shop: Game["shop"], objectId: string) {
    const gameKey = levelKeys.game(shop, objectId);
    const [download, game] = await Promise.all([
      downloadsSublevel.get(gameKey),
      gamesSublevel.get(gameKey),
    ]);

    if (!download || !game) {
      const gameFilesManager = new GameFilesManager(shop, objectId);
      await gameFilesManager.failExtraction(
        new Error(
          "Could not start extraction because download metadata is missing"
        )
      );
      return false;
    }

    await downloadsSublevel.put(gameKey, {
      ...download,
      extracting: true,
    });
    WindowManager.sendDownloadsUpdated();

    try {
      await this.run(download, game);
      return true;
    } catch {
      return false;
    }
  }

  private static async ensureExtractingFlag(
    download: Download,
    force = false
  ) {
    const gameKey = levelKeys.game(download.shop, download.objectId);
    const current = await downloadsSublevel.get(gameKey);
    if (!current) return;

    if (force || !current.extracting) {
      await downloadsSublevel.put(gameKey, {
        ...current,
        extracting: true,
      });
      WindowManager.sendDownloadsUpdated();
    }
  }

  private static async prepare(download: Download, attemptNumber: number) {
    if (download.downloader === Downloader.Torrent) {
      await this.releaseTorrentArchivesWithRetry(download, attemptNumber);
      return;
    }

    await this.waitUntilExtractionSourcesUnlocked(download);
  }

  private static async releaseTorrentArchivesWithRetry(
    download: Download,
    attemptNumber: number
  ) {
    let lastError: unknown;
    const attempts = Math.min(
      TORRENT_RELEASE_ATTEMPTS + Math.floor((attemptNumber - 1) / 2),
      TORRENT_RELEASE_ATTEMPTS + 6
    );

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await DownloadManager.releaseTorrentFiles(download);
      } catch (error) {
        lastError = error;
        logger.warn(
          `[ExtractionCoordinator] release_files RPC failed (attempt ${attempt + 1}/${attempts})`,
          error
        );
      }

      const settleMs = Math.min(
        TORRENT_RELEASE_SETTLE_BASE_MS * (attempt + 1),
        TORRENT_RELEASE_SETTLE_MAX_MS
      );
      await sleep(settleMs);

      try {
        await this.waitUntilExtractionSourcesUnlocked(download);
        logger.info(
          `[ExtractionCoordinator] Archives unlocked for extraction after ${attempt + 1} release attempt(s) (extract try #${attemptNumber})`
        );
        return;
      } catch (error) {
        lastError = error;
        logger.warn(
          `[ExtractionCoordinator] Archives still locked (release ${attempt + 1}/${attempts}, extract try #${attemptNumber})`,
          error
        );
      }
    }

    // Soft-continue: still attempt 7-Zip; outer retry loop will try again.
    logger.warn(
      `[ExtractionCoordinator] Proceeding to extract despite lock probe failures for ${download.folderName ?? download.objectId}`,
      lastError
    );
  }

  private static async waitUntilExtractionSourcesUnlocked(
    download: Download
  ) {
    if (!download.folderName) return;

    const extractionRoot = path.join(
      download.downloadPath,
      download.folderName
    );

    if (!fs.existsSync(extractionRoot)) {
      throw new Error(`Extraction path does not exist: ${extractionRoot}`);
    }

    const archivePaths =
      await GameFilesManager.findArchivePathsInDirectory(extractionRoot);

    if (archivePaths.length === 0) {
      await this.waitUntilPathUnlocked(extractionRoot);
      return;
    }

    for (const archivePath of archivePaths) {
      await this.waitUntilPathUnlocked(archivePath);
    }
  }

  /**
   * Stronger than R_OK: rename-to-self probe (fails under Windows share locks)
   * plus open for read-write when the path is a file.
   */
  private static async waitUntilPathUnlocked(targetPath: string) {
    let lastError: unknown;

    for (let attempt = 0; attempt < FILE_READINESS_MAX_ATTEMPTS; attempt++) {
      try {
        await this.assertPathUnlocked(targetPath);
        return;
      } catch (error) {
        lastError = error;
        await sleep(FILE_READINESS_POLL_MS);
      }
    }

    throw new Error(
      `Archive path is locked or unreadable: ${targetPath}${
        lastError instanceof Error ? ` (${lastError.message})` : ""
      }`
    );
  }

  private static async assertPathUnlocked(targetPath: string) {
    await fs.promises.access(targetPath, fs.constants.R_OK);

    const stats = await fs.promises.stat(targetPath);

    if (stats.isDirectory()) {
      // Directory: open for read is enough; archive files are checked individually.
      const handle = await fs.promises.open(targetPath, "r");
      await handle.close();
      return;
    }

    // Rename probe — classic Windows signal that another process still holds the file.
    const directory = path.dirname(targetPath);
    const baseName = path.basename(targetPath);
    const probePath = path.join(
      directory,
      `.${baseName}.gl-unlock-${process.pid}`
    );

    try {
      await fs.promises.rename(targetPath, probePath);
      await fs.promises.rename(probePath, targetPath);
    } catch (error) {
      // Best-effort restore if half-renamed.
      try {
        if (fs.existsSync(probePath) && !fs.existsSync(targetPath)) {
          await fs.promises.rename(probePath, targetPath);
        }
      } catch {
        /* ignore restore errors */
      }
      throw error;
    }

    // Prefer exclusive-ish write open; fall back to read if the FS is read-only.
    try {
      const rw = await fs.promises.open(targetPath, "r+");
      await rw.close();
    } catch {
      const ro = await fs.promises.open(targetPath, "r");
      await ro.close();
    }
  }

  private static async promptContinueExtraction(
    game: Game,
    totalAttempts: number,
    lastError: unknown
  ): Promise<boolean> {
    const language = await db
      .get<string, string>(levelKeys.language, { valueEncoding: "utf8" })
      .catch(() => "en");
    const isVi =
      typeof language === "string" && language.toLowerCase().startsWith("vi");

    const title = isVi ? "Giải nén thất bại" : "Extraction failed";
    const message = isVi
      ? `Đã thử giải nén "${game.title}" ${totalAttempts} lần nhưng vẫn lỗi.\n\nBạn có muốn tiếp tục thử thêm ${ATTEMPTS_PER_BATCH} lần nữa không?`
      : `Could not extract "${game.title}" after ${totalAttempts} attempt(s).\n\nKeep trying another ${ATTEMPTS_PER_BATCH} times?`;
    const detail = isVi
      ? `Chi tiết: ${formatErrorMessage(lastError)}\n\nGợi ý: tạm dừng seed / tắt antivirus quét folder game nếu file đang bị khóa.`
      : `Details: ${formatErrorMessage(lastError)}\n\nTip: pause seeding or exclude the game folder from antivirus if the archive stays locked.`;
    const buttons = isVi
      ? ["Thử tiếp", "Dừng"]
      : ["Keep trying", "Stop"];

    const parent = WindowManager.mainWindow;

    try {
      const result = parent
        ? await dialog.showMessageBox(parent, {
            type: "warning",
            buttons,
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title,
            message,
            detail,
          })
        : await dialog.showMessageBox({
            type: "warning",
            buttons,
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title,
            message,
            detail,
          });

      return result.response === 0;
    } catch (error) {
      logger.error(
        "[ExtractionCoordinator] Failed to show continue-extraction dialog",
        error
      );
      return false;
    }
  }
}
