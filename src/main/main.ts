import { downloadsSublevel } from "./level/sublevels/downloads";
import { orderBy } from "lodash-es";
import { Downloader } from "@shared";
import { levelKeys, db } from "./level";
import { type Download, type UserPreferences } from "../types";
import path from "node:path";
import fs from "node:fs";
import {
  SystemPath,
  CommonRedistManager,
  TorBoxClient,
  RealDebridClient,
  PremiumizeClient,
  AllDebridClient,
  DownloadManager,
  ApiClient,
  uploadGamesBatch,
  startMainLoop,
  Ludusavi,
  Lock,
  DownloadSourcesChecker,
  DownloadOrchestrator,
  WSClient,
  WindowManager,
  logger,
} from "@main/services";
import { migrateDownloadSources } from "./helpers/migrate-download-sources";
import { getDirSize } from "./services/download/helpers";
import { GofileApi } from "./services/hosters";
import { seedDownloadSources } from "./helpers/seed-download-sources";

const hasMissingSeedFiles = async (download: Download): Promise<boolean> => {
  if (!download.folderName) return false;

  const downloadTargetPath = path.join(
    download.downloadPath,
    download.folderName
  );

  if (!fs.existsSync(downloadTargetPath)) {
    return true;
  }

  const expectedSize = download.selectedFilesSize ?? download.fileSize ?? 0;

  if (expectedSize <= 0) {
    return false;
  }

  const currentSize = await getDirSize(downloadTargetPath);
  return currentSize < expectedSize;
};

/**
 * Critical startup only — must stay offline-safe and fast so the splash can
 * hand off to the main window. Network, seed scans, RPC, and main loop run in
 * `loadStateDeferred`.
 */
export const loadState = async () => {
  await Lock.acquireLock();

  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    {
      valueEncoding: "json",
    }
  );

  // Register all IPC handlers before the renderer loads.
  await import("./events");

  if (userPreferences?.realDebridApiToken) {
    RealDebridClient.authorize(userPreferences.realDebridApiToken);
  }

  if (userPreferences?.premiumizeApiToken) {
    PremiumizeClient.authorize(userPreferences.premiumizeApiToken);
  }

  if (userPreferences?.allDebridApiToken) {
    AllDebridClient.authorize(userPreferences.allDebridApiToken);
  }

  if (userPreferences?.torBoxApiToken) {
    TorBoxClient.authorize(userPreferences.torBoxApiToken);
  }

  GofileApi.initialize();

  try {
    Ludusavi.copyConfigFileToUserData();
    Ludusavi.copyBinaryToUserData();
  } catch (error) {
    logger.error("[Startup] Ludusavi copy failed (continuing)", error);
  }

  // Local auth from LevelDB only — no network wait here.
  await ApiClient.setupApi();

  // Create portable default download folder (`<exe>/game`) on first launch.
  try {
    const { ensureDefaultGameFolder } = await import(
      "./helpers/ensure-downloads-path"
    );
    ensureDefaultGameFolder();
  } catch (error) {
    logger.error("[Startup] Failed to create default game folder", error);
  }

  // Warm the Go torrent RPC early so the first magnet start is not cold-spawn.
  void DownloadManager.startRPC().catch((error) => {
    logger.error("[Startup] Failed to pre-start Go RPC", error);
  });
};

/**
 * Heavy / network work after the main window is shown.
 * Safe to call without awaiting from the UI bootstrap path.
 */
export const loadStateDeferred = async () => {
  try {
    // Background network tasks (must not block UI).
    void uploadGamesBatch();
    void migrateDownloadSources();
    void import("./services/user")
      .then(({ syncDownloadSourcesFromApi }) => syncDownloadSourcesFromApi())
      .catch((error) =>
        logger.error("[Startup] syncDownloadSourcesFromApi failed", error)
      );
    void seedDownloadSources();
    void DownloadSourcesChecker.checkForChanges().catch((error) =>
      logger.error("[Startup] DownloadSourcesChecker failed", error)
    );
    void WSClient.connect();

    const downloadToResume =
      await DownloadOrchestrator.bootstrapDownloadsOnStartup();
    const normalizedDownloads = await downloadsSublevel
      .values()
      .all()
      .then((games) => orderBy(games, "timestamp", "desc"));

    const downloadsToSeed: Download[] = [];

    for (const game of normalizedDownloads) {
      if (
        !game.shouldSeed ||
        game.downloader !== Downloader.Torrent ||
        game.progress !== 1 ||
        game.status !== "seeding" ||
        game.uri === null ||
        // Do not re-lock archives that are mid-extraction (pending or active).
        game.extracting
      ) {
        continue;
      }

      // Skip expensive recursive size scan when we already know progress is 1
      // and folder exists — only check missing path.
      const folderMissing =
        !game.folderName ||
        !fs.existsSync(path.join(game.downloadPath, game.folderName));

      if (!folderMissing) {
        // Cheap existence check only; full size verify is optional & capped.
        let missing = false;
        try {
          missing = await Promise.race([
            hasMissingSeedFiles(game),
            new Promise<boolean>((resolve) => {
              setTimeout(() => resolve(false), 3_000);
            }),
          ]);
        } catch {
          missing = false;
        }

        if (!missing) {
          downloadsToSeed.push(game);
          continue;
        }
      }

      const gameKey = levelKeys.game(game.shop, game.objectId);
      const expectedSize = game.selectedFilesSize ?? game.fileSize ?? 0;
      let progress = game.progress;

      if (game.folderName) {
        const downloadTargetPath = path.join(
          game.downloadPath,
          game.folderName
        );
        const currentSize = fs.existsSync(downloadTargetPath)
          ? await Promise.race([
              getDirSize(downloadTargetPath),
              new Promise<number>((resolve) => {
                setTimeout(() => resolve(expectedSize), 3_000);
              }),
            ])
          : 0;
        progress =
          expectedSize > 0
            ? Math.min(currentSize / expectedSize, 1)
            : game.progress;
      }

      await downloadsSublevel.put(gameKey, {
        ...game,
        status: "paused",
        shouldSeed: false,
        queued: false,
        pinnedToHero: false,
        progress,
      });

      logger.warn(
        `[Startup] Seed files missing for ${gameKey}; seeding was disabled`
      );
    }

    const isTorrent = downloadToResume?.downloader === Downloader.Torrent;

    const startDownloads = async () => {
      if (downloadToResume && !isTorrent) {
        await DownloadManager.startRPC(undefined, downloadsToSeed);
        await DownloadManager.startDownload(downloadToResume).catch((err) => {
          logger.error("Failed to auto-resume download:", err);
        });
      } else {
        await DownloadManager.startRPC(
          downloadToResume ?? undefined,
          downloadsToSeed
        );
      }
    };

    void startDownloads().catch((err) => {
      logger.error("Failed to start downloads/RPC on startup:", err);
    });

    WindowManager.sendDownloadsUpdated();
    startMainLoop();

    void CommonRedistManager.downloadCommonRedist();
    SystemPath.checkIfPathsAreAvailable();
  } catch (error) {
    logger.error("[Startup] loadStateDeferred failed", error);
    // Still start the main loop so download watchers / process watcher work.
    try {
      startMainLoop();
    } catch (loopError) {
      logger.error("[Startup] startMainLoop failed", loopError);
    }
  }
};
