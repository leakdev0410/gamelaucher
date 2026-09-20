import { Downloader, DownloadError, isArchiveFile } from "@shared";
import { WindowManager } from "../window-manager";
import { publishDownloadCompleteNotification } from "../notifications";
import type { Download, DownloadProgress, Game, UserPreferences } from "@types";
import {
  GofileApi,
  DatanodesApi,
  MediafireApi,
  PixelDrainApi,
  VikingFileApi,
  RootzApi,
} from "../hosters";
import { GoRPC } from "../go-rpc";
import {
  LibtorrentPayload,
  LibtorrentStatus,
  PauseDownloadPayload,
} from "./types";
import { calculateETA, getDirSize } from "./helpers";
import { RealDebridClient } from "./real-debrid";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../logger";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { TorBoxClient } from "./torbox";
import { GameFilesManager } from "../game-files-manager";
import { PremiumizeClient } from "./premiumize";
import { AllDebridClient } from "./all-debrid";
import { BuzzheavierApi, FuckingFastApi } from "@main/services/hosters";
import { JsHttpDownloader } from "./js-http-downloader";
import { getDirectorySize } from "@main/events/helpers/get-directory-size";
import {
  getDownloadLayoutStateRecord,
  getNextQueuedDownloadFromLayout,
} from "../download-layout-state";

interface AllDebridBatchEntry {
  url: string;
  filename: string;
  size?: number;
  isLocked?: boolean;
}

interface AllDebridBatchState {
  downloadId: string;
  gameId: string;
  savePath: string;
  entries: AllDebridBatchEntry[];
  currentIndex: number;
  completedBytes: number;
  totalBytes: number;
  lastSpeedUpdate: number;
  bytesAtLastSpeedUpdate: number;
  batchSpeed: number;
}

export class DownloadManager {
  private static downloadingGameId: string | null = null;
  private static jsDownloader: JsHttpDownloader | null = null;
  private static usingJsDownloader = false;
  private static isPreparingDownload = false;
  private static allDebridBatch: AllDebridBatchState | null = null;
  private static maxDownloadSpeedBytesPerSecond: number | null = null;
  private static completingGameId: string | null = null;
  private static handlingJsErrorGameId: string | null = null;
  private static rpcStatusFailures = 0;
  private static readonly MAX_RPC_STATUS_FAILURES = 8;

  public static hasActiveDownload() {
    return this.downloadingGameId !== null || this.isPreparingDownload;
  }

  private static clearRuntimeDownloadState() {
    this.downloadingGameId = null;
    this.usingJsDownloader = false;
    this.jsDownloader = null;
    this.allDebridBatch = null;
    this.isPreparingDownload = false;
    WindowManager.mainWindow?.setProgressBar(-1);
    WindowManager.sendToAppWindows("on-download-progress", null);
  }

  private static async persistDownloadError(
    downloadId: string,
    download: Download,
    error?: unknown
  ) {
    if (error) {
      logger.error("[DownloadManager] Download failed:", error);
    }

    try {
      const current = await downloadsSublevel.get(downloadId).catch(() => null);
      const base = current ?? download;
      await downloadsSublevel.put(downloadId, {
        ...base,
        status: "error",
        queued: false,
        pinnedToHero: false,
        extracting: false,
      });
      WindowManager.sendDownloadsUpdated();
    } catch (dbErr) {
      logger.error("[DownloadManager] Failed to persist error status", dbErr);
    }
  }

  private static extractFilename(
    url: string,
    originalUrl?: string
  ): string | undefined {
    if (originalUrl?.includes("#")) {
      const hashPart = originalUrl.split("#")[1];
      if (hashPart && !hashPart.startsWith("http") && hashPart.includes(".")) {
        return hashPart;
      }
    }

    if (url.includes("#")) {
      const hashPart = url.split("#")[1];
      if (hashPart && !hashPart.startsWith("http") && hashPart.includes(".")) {
        return hashPart;
      }
    }

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const pathParts = pathname.split("/");
      const filename = pathParts.at(-1);

      if (filename?.includes(".") && filename.length > 0) {
        return decodeURIComponent(filename);
      }
    } catch {
      // Invalid URL
    }

    return undefined;
  }

  private static sanitizeFilename(filename: string): string {
    return filename.replaceAll(/[<>:"/\\|?*]/g, "_");
  }

  private static sanitizeRelativePath(pathValue: string): string {
    return pathValue
      .split(/[\\/]+/)
      .map((segment) => this.sanitizeFilename(segment))
      .filter(Boolean)
      .join("/");
  }

  private static resolveFilename(
    resumingFilename: string | undefined,
    originalUrl: string,
    downloadUrl: string
  ): string | undefined {
    const extracted =
      this.extractFilename(originalUrl, downloadUrl) ||
      this.extractFilename(downloadUrl);

    if (extracted) {
      const sanitized = this.sanitizeFilename(extracted);

      if (
        resumingFilename &&
        resumingFilename !== sanitized &&
        !resumingFilename.endsWith(sanitized) &&
        !sanitized.endsWith(resumingFilename)
      ) {
        logger.warn(
          `[DownloadManager] Resolved filename changed: was "${resumingFilename}", now "${sanitized}"`
        );
      }

      return sanitized;
    }

    return resumingFilename;
  }

  private static buildDownloadOptions(
    url: string,
    savePath: string,
    filename: string | undefined,
    headers?: Record<string, string>
  ) {
    return {
      url,
      savePath,
      filename,
      headers,
    };
  }

  private static parseGofileUri(uri: string) {
    let normalizedUri = uri.trim();

    if (
      !normalizedUri.startsWith("http://") &&
      !normalizedUri.startsWith("https://")
    ) {
      normalizedUri = `https://${normalizedUri}`;
    }

    try {
      const parsed = new URL(normalizedUri);
      const id = parsed.pathname.split("/").filter(Boolean).pop() || "";
      const password = parsed.searchParams.get("password") || undefined;

      return {
        id,
        password,
      };
    } catch {
      const id =
        normalizedUri.split("?")[0].split("/").filter(Boolean).pop() || "";
      return {
        id,
        password: undefined,
      };
    }
  }

  private static logResolvedUrl(url: string): void {
    let sanitizedUrl = url;

    try {
      const parsedUrl = new URL(url);
      sanitizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
    } catch {
      sanitizedUrl = url.replace(/[?#].*$/, "");
    }

    logger.log(`[DownloadManager] Resolved URL: ${sanitizedUrl}`);
  }

  private static isHttpDownloader(downloader: Downloader): boolean {
    return downloader !== Downloader.Torrent;
  }

  private static normalizeDownloadSpeedLimit(
    value?: number | null
  ): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return null;
    }

    return Math.floor(value);
  }

  private static async getPersistedDownloadSpeedLimit() {
    const userPreferences = await db.get<string, UserPreferences | null>(
      levelKeys.userPreferences,
      { valueEncoding: "json" }
    );

    return this.normalizeDownloadSpeedLimit(
      userPreferences?.maxDownloadSpeedBytesPerSecond
    );
  }

  public static async applyDownloadSpeedLimit(
    value?: number | null
  ): Promise<void> {
    const normalizedLimit =
      value === undefined
        ? await this.getPersistedDownloadSpeedLimit()
        : this.normalizeDownloadSpeedLimit(value);

    this.maxDownloadSpeedBytesPerSecond = normalizedLimit;
    this.jsDownloader?.setMaxDownloadSpeedBytesPerSecond(normalizedLimit);

    await GoRPC.rpc
      .call("action", {
        action: "set_download_limit",
        max_download_speed_bytes_per_second: normalizedLimit,
      })
      .catch((error) => {
        logger.error(
          "[DownloadManager] Failed to update RPC download speed limit:",
          error
        );
      });
  }

  public static async startRPC(
    download?: Download,
    downloadsToSeed?: Download[]
  ) {
    await GoRPC.spawn();

    if (downloadsToSeed?.length) {
      for (const seedDownload of downloadsToSeed) {
        await this.resumeSeeding(seedDownload).catch((error) => {
          logger.error("[DownloadManager] Failed to resume seeding", error);
        });
      }
    }

    if (download) {
      await this.startDownload(download).catch((error) => {
        logger.error("[DownloadManager] Failed to resume download", error);
      });
    }

    await this.applyDownloadSpeedLimit();
  }

  private static async getDownloadStatusFromJs(): Promise<DownloadProgress | null> {
    if (!this.downloadingGameId) return null;

    const downloadId = this.downloadingGameId;

    // Return a "preparing" status while fetching download options
    if (this.isPreparingDownload) {
      try {
        const download = await downloadsSublevel.get(downloadId);
        if (!download) return null;

        return {
          numPeers: 0,
          numSeeds: 0,
          downloadSpeed: 0,
          timeRemaining: -1,
          isDownloadingMetadata: true, // Use this to indicate "preparing"
          isCheckingFiles: false,
          progress: 0,
          gameId: downloadId,
          download,
        };
      } catch {
        return null;
      }
    }

    if (!this.jsDownloader) return null;

    const status = this.jsDownloader.getDownloadStatus();
    if (!status) return null;

    try {
      const download = await downloadsSublevel.get(downloadId);
      if (!download) return null;

      if (status.status === "error") {
        if (this.handlingJsErrorGameId !== downloadId) {
          this.handlingJsErrorGameId = downloadId;
          await this.persistDownloadError(downloadId, download);
          this.clearRuntimeDownloadState();
          this.handlingJsErrorGameId = null;
          void this.processNextQueuedDownload();
        }
        return null;
      }

      let { progress, bytesDownloaded, fileSize, folderName } = status;
      let downloadSpeed = status.downloadSpeed;
      let batchFilesTotal: number | undefined;
      let batchFilesDownloaded: number | undefined;

      if (
        this.allDebridBatch &&
        this.allDebridBatch.downloadId === downloadId
      ) {
        const batch = this.allDebridBatch;
        const batchDone =
          batch.currentIndex >= batch.entries.length &&
          status.status === "complete";

        batchFilesTotal = batch.entries.length;

        if (batchDone) {
          this.allDebridBatch = null;
          progress = 1;
          bytesDownloaded = batch.completedBytes;
          fileSize = batch.totalBytes;
          batchFilesDownloaded = batchFilesTotal;
        } else {
          if (status.status === "complete") {
            status.status = "active";
          }

          const currentBytes =
            status.status === "active" ? status.bytesDownloaded : 0;

          progress = this.calculateAllDebridBatchProgress(
            batch,
            status.progress,
            currentBytes,
            status.fileSize
          );
          bytesDownloaded = batch.completedBytes + currentBytes;
          fileSize = batch.totalBytes || fileSize;
          folderName =
            batch.entries[batch.currentIndex]?.filename ?? folderName;
          batchFilesDownloaded = batch.currentIndex;

          // Compute batch-level speed so small files don't reset the reading
          const now = Date.now();
          const elapsed = (now - batch.lastSpeedUpdate) / 1000;
          if (elapsed >= 1) {
            const bytesDelta = bytesDownloaded - batch.bytesAtLastSpeedUpdate;
            batch.batchSpeed = Math.max(0, bytesDelta / elapsed);
            batch.lastSpeedUpdate = now;
            batch.bytesAtLastSpeedUpdate = bytesDownloaded;
          }
          downloadSpeed = batch.batchSpeed;
        }
      }

      const effectiveFileSize = fileSize > 0 ? fileSize : download.fileSize;

      const updatedDownload = {
        ...download,
        bytesDownloaded,
        fileSize: effectiveFileSize,
        progress,
        folderName,
        status:
          status.status === "complete"
            ? ("complete" as const)
            : ("active" as const),
      };

      if (status.status === "active" || status.status === "complete") {
        await downloadsSublevel.put(downloadId, updatedDownload);
      }

      return {
        numPeers: 0,
        numSeeds: 0,
        downloadSpeed,
        timeRemaining: calculateETA(
          effectiveFileSize ?? 0,
          bytesDownloaded,
          downloadSpeed
        ),
        isDownloadingMetadata: false,
        isCheckingFiles: false,
        progress,
        gameId: downloadId,
        download: updatedDownload,
        batchFilesTotal,
        batchFilesDownloaded,
      };
    } catch (err) {
      logger.error("[DownloadManager] Error getting JS download status:", err);
      return null;
    }
  }

  private static async buildTorrentMetadataProgress(
    downloadId: string
  ): Promise<DownloadProgress | null> {
    const download = await downloadsSublevel.get(downloadId).catch(() => null);
    if (!download || download.downloader !== Downloader.Torrent) return null;

    return {
      numPeers: 0,
      numSeeds: 0,
      downloadSpeed: 0,
      timeRemaining: -1,
      isDownloadingMetadata: true,
      isCheckingFiles: false,
      progress: download.progress ?? 0,
      gameId: downloadId,
      download,
    };
  }

  private static async handleRpcStatusPollFailure(downloadId: string) {
    if (this.isPreparingDownload) {
      return this.buildTorrentMetadataProgress(downloadId);
    }

    this.rpcStatusFailures += 1;

    if (this.rpcStatusFailures < this.MAX_RPC_STATUS_FAILURES) {
      return this.buildTorrentMetadataProgress(downloadId);
    }

    const download = await downloadsSublevel.get(downloadId).catch(() => null);
    if (!download) {
      this.clearRuntimeDownloadState();
      return null;
    }

    logger.error(
      `[DownloadManager] Go RPC status unavailable for ${downloadId} after ${this.rpcStatusFailures} polls`
    );

    await this.persistDownloadError(
      downloadId,
      download,
      new Error(DownloadError.TorrentMetadataTimeout)
    );
    this.clearRuntimeDownloadState();
    this.rpcStatusFailures = 0;
    void this.processNextQueuedDownload();

    return null;
  }

  private static async getDownloadStatusFromRpc(): Promise<DownloadProgress | null> {
    if (!this.downloadingGameId) return null;

    const downloadId = this.downloadingGameId;
    let response: { data: LibtorrentPayload | null };

    try {
      response = await GoRPC.rpc.call<LibtorrentPayload | null>("status");
      this.rpcStatusFailures = 0;
    } catch (error) {
      logger.error("[DownloadManager] RPC status poll failed", error);
      return this.handleRpcStatusPollFailure(downloadId);
    }

    if (response.data === null) {
      return this.handleRpcStatusPollFailure(downloadId);
    }

    try {
      const {
        progress,
        numPeers,
        numSeeds,
        downloadSpeed,
        bytesDownloaded,
        fileSize,
        folderName,
        status,
      } = response.data;

      const isDownloadingMetadata =
        status === LibtorrentStatus.DownloadingMetadata;
      const isCheckingFiles = status === LibtorrentStatus.CheckingFiles;

      const download = await downloadsSublevel.get(downloadId);

      if (!isDownloadingMetadata && !isCheckingFiles) {
        if (!download) return null;

        const effectiveFileSize =
          fileSize > 0
            ? fileSize
            : (download.selectedFilesSize ?? download.fileSize ?? 0);

        await downloadsSublevel.put(downloadId, {
          ...download,
          bytesDownloaded,
          fileSize: effectiveFileSize,
          progress,
          folderName,
          status: "active",
        });
      }

      return {
        numPeers,
        numSeeds,
        downloadSpeed,
        timeRemaining: calculateETA(
          fileSize > 0
            ? fileSize
            : (download?.selectedFilesSize ?? download?.fileSize ?? 0),
          bytesDownloaded,
          downloadSpeed
        ),
        isDownloadingMetadata,
        isCheckingFiles,
        progress,
        gameId: downloadId,
        download,
      } as DownloadProgress;
    } catch {
      return null;
    }
  }

  private static async getDownloadStatus(): Promise<DownloadProgress | null> {
    if (this.usingJsDownloader) {
      return this.getDownloadStatusFromJs();
    }
    return this.getDownloadStatusFromRpc();
  }

  public static async watchDownloads() {
    const status = await this.getDownloadStatus();
    if (!status) return;

    const { gameId, progress } = status;
    const [download, game] = await Promise.all([
      downloadsSublevel.get(gameId),
      gamesSublevel.get(gameId),
    ]);

    if (!download || !game) return;

    this.sendProgressUpdate(progress, status, game);

    const isComplete =
      !status.isCheckingFiles &&
      !status.isDownloadingMetadata &&
      (progress >= 0.999 || download.status === "complete");
    if (isComplete) {
      await this.handleDownloadCompletion(download, game, gameId);
    }
  }

  private static sendProgressUpdate(
    progress: number,
    status: DownloadProgress,
    game: Game
  ) {
    if (WindowManager.mainWindow) {
      WindowManager.mainWindow.setProgressBar(progress === 1 ? -1 : progress);
    }

    WindowManager.sendToAppWindows(
      "on-download-progress",
      structuredClone({ ...status, game })
    );
  }

  private static async handleDownloadCompletion(
    download: Download,
    game: Game,
    gameId: string
  ) {
    if (this.completingGameId === gameId) {
      return;
    }

    this.completingGameId = gameId;

    try {
      publishDownloadCompleteNotification(game);

      const userPreferences = await db.get<string, UserPreferences | null>(
        levelKeys.userPreferences,
        { valueEncoding: "json" }
      );

      const shouldSeed = await this.updateDownloadStatus(
        download,
        gameId,
        userPreferences?.seedAfterDownloadComplete
      );

      if (download.folderName) {
        const installerPath = path.join(
          download.downloadPath,
          download.folderName
        );

        getDirectorySize(installerPath).then(async (installerSizeInBytes) => {
          const currentGame = await gamesSublevel.get(gameId);
          if (!currentGame) return;

          await gamesSublevel.put(gameId, {
            ...currentGame,
            installerSizeInBytes,
          });
        });
      }

      if (download.automaticallyExtract) {
        const { ExtractionCoordinator } = await import(
          "../extraction-coordinator"
        );
        await ExtractionCoordinator.run(download, game);

        if (!shouldSeed && download.downloader !== Downloader.Torrent) {
          await this.cancelDownload(gameId);
        }
      } else {
        const gameFilesManager = new GameFilesManager(game.shop, game.objectId);
        gameFilesManager.searchAndBindExecutable();
        if (!shouldSeed) {
          await this.cancelDownload(gameId);
        }
      }

      await this.processNextQueuedDownload();
    } finally {
      if (this.completingGameId === gameId) {
        this.completingGameId = null;
      }
    }
  }

  private static async updateDownloadStatus(
    download: Download,
    gameId: string,
    shouldSeed?: boolean
  ): Promise<boolean> {
    const shouldExtract = download.automaticallyExtract;
    const isSelectiveTorrent =
      download.downloader === Downloader.Torrent &&
      Array.isArray(download.fileIndices) &&
      download.fileIndices.length > 0;

    if (
      shouldSeed &&
      download.downloader === Downloader.Torrent &&
      !isSelectiveTorrent
    ) {
      await downloadsSublevel.put(gameId, {
        ...download,
        status: "seeding",
        shouldSeed: true,
        queued: false,
        pinnedToHero: false,
        extracting: shouldExtract,
      });
      WindowManager.sendDownloadsUpdated();

      return true;
    }

    await downloadsSublevel.put(gameId, {
      ...download,
      status: "complete",
      shouldSeed: false,
      queued: false,
      pinnedToHero: false,
      extracting: shouldExtract,
    });
    WindowManager.sendDownloadsUpdated();

    return false;
  }

  /**
   * Perform one extraction pass. Throws on failure so
   * {@link ExtractionCoordinator} can retry; does not mark final failure state.
   */
  public static async handleExtraction(download: Download, game: Game) {
    const gameFilesManager = new GameFilesManager(game.shop, game.objectId);
    const targetFolderName = download.folderName;

    if (!targetFolderName) {
      throw new Error("No downloaded archive was found to extract");
    }

    const extractionPath = path.join(download.downloadPath, targetFolderName);

    if (!fs.existsSync(extractionPath)) {
      throw new Error("No downloaded archive was found to extract");
    }

    const extractionStats = fs.statSync(extractionPath);

    if (extractionStats.isFile() && isArchiveFile(targetFolderName)) {
      await gameFilesManager.extractDownloadedFile();
      return;
    }

    if (extractionStats.isDirectory()) {
      await gameFilesManager.extractFilesInDirectory(extractionPath);
      await gameFilesManager.setExtractionComplete();
      return;
    }

    throw new Error(
      `Invalid extraction source type for "${download.folderName ?? "unknown"}"`
    );
  }

  private static async processNextQueuedDownload() {
    const downloads = await downloadsSublevel.values().all();
    const layoutState = await getDownloadLayoutStateRecord();
    const nextItemOnQueue = getNextQueuedDownloadFromLayout(
      downloads,
      layoutState
    );

    if (nextItemOnQueue) {
      try {
        await this.resumeDownload(nextItemOnQueue);
      } catch (error) {
        const downloadId = levelKeys.game(
          nextItemOnQueue.shop,
          nextItemOnQueue.objectId
        );

        logger.error(
          "[DownloadManager] Failed to resume next queued download",
          error
        );

        await downloadsSublevel.put(downloadId, {
          ...nextItemOnQueue,
          status: "error",
          queued: false,
          pinnedToHero: false,
          extracting: false,
        });

        this.downloadingGameId = null;
        this.usingJsDownloader = false;
        this.jsDownloader = null;
        this.allDebridBatch = null;
        this.isPreparingDownload = false;
        WindowManager.mainWindow?.setProgressBar(-1);
        WindowManager.sendDownloadsUpdated();

        await this.processNextQueuedDownload();
      }
    } else {
      this.downloadingGameId = null;
      this.usingJsDownloader = false;
      this.jsDownloader = null;
      this.allDebridBatch = null;
    }
  }

  public static async getSeedStatus() {
    let seedStatus: LibtorrentPayload[] = [];

    try {
      seedStatus =
        (await GoRPC.rpc
          .call<LibtorrentPayload[] | null>("seed_status")
          .then((res) => res.data)) ?? [];
    } catch (error) {
      logger.error("[DownloadManager] RPC seed status poll failed", error);
      WindowManager.sendToAppWindows("on-seeding-status", []);
      return;
    }

    if (!Array.isArray(seedStatus) || !seedStatus.length) {
      WindowManager.sendToAppWindows("on-seeding-status", []);
      return;
    }

    logger.log(seedStatus);

    for (const status of seedStatus) {
      const download = await downloadsSublevel.get(status.gameId);

      if (!download) continue;

      const totalSize = await getDirSize(
        path.join(download.downloadPath, status.folderName)
      );

      // After extract+delete-archives, on-disk size can be smaller than the
      // original torrent payload. Only demote incomplete seeds (progress < 1).
      const expectedSize =
        download.selectedFilesSize ?? status.fileSize ?? download.fileSize ?? 0;
      const isCompleteSeed =
        (download.progress ?? 0) >= 1 || download.status === "seeding";

      if (totalSize < expectedSize && !isCompleteSeed) {
        await this.pauseSeeding(status.gameId);

        await downloadsSublevel.put(status.gameId, {
          ...download,
          status: "paused",
          shouldSeed: false,
          pinnedToHero: false,
          progress:
            expectedSize > 0
              ? Math.min(totalSize / expectedSize, 1)
              : download.progress,
        });
        WindowManager.sendDownloadsUpdated();

        WindowManager.sendToAppWindows("on-hard-delete");
      } else if (totalSize < expectedSize && isCompleteSeed) {
        logger.warn(
          `[DownloadManager] Seed size smaller than expected for ${status.gameId} (disk=${totalSize}, expected=${expectedSize}); keeping seeding (likely extracted/deleted archives)`
        );
      }
    }

    WindowManager.sendToAppWindows("on-seeding-status", seedStatus);
  }

  static async pauseDownload(downloadKey = this.downloadingGameId) {
    if (this.usingJsDownloader && this.jsDownloader) {
      logger.log("[DownloadManager] Pausing JS download");
      this.jsDownloader.pauseDownload();
    } else if (downloadKey) {
      await GoRPC.rpc
        .call("action", {
          action: "pause",
          game_id: downloadKey,
        } as PauseDownloadPayload)
        .catch(() => {});
    }

    if (downloadKey === this.downloadingGameId) {
      WindowManager.mainWindow?.setProgressBar(-1);
      this.downloadingGameId = null;
    }
  }

  static async resumeDownload(download: Download) {
    return this.startDownload(download);
  }

  static async cancelDownload(downloadKey = this.downloadingGameId) {
    const isActiveDownload = downloadKey === this.downloadingGameId;

    if (isActiveDownload) {
      if (this.usingJsDownloader && this.jsDownloader) {
        logger.log("[DownloadManager] Cancelling JS download");
        this.jsDownloader.cancelDownload();
        this.jsDownloader = null;
        this.usingJsDownloader = false;
        this.allDebridBatch = null;
      } else {
        await GoRPC.rpc
          .call("action", { action: "cancel", game_id: downloadKey })
          .catch((err) => logger.error("Failed to cancel game download", err));
      }

      WindowManager.mainWindow?.setProgressBar(-1);
      WindowManager.sendToAppWindows("on-download-progress", null);
      this.downloadingGameId = null;
      this.isPreparingDownload = false;
      this.usingJsDownloader = false;
      this.allDebridBatch = null;
    } else if (downloadKey) {
      await GoRPC.rpc
        .call("action", { action: "cancel", game_id: downloadKey })
        .catch((err) => logger.error("Failed to cancel game download", err));
    }
  }

  static async resumeSeeding(download: Download) {
    const gameId = levelKeys.game(download.shop, download.objectId);

    // Never re-attach torrent handles while extraction is still holding/retrying files.
    // Use live DB + in-memory set only (caller snapshot of `extracting` may be stale).
    const { ExtractionCoordinator } = await import("../extraction-coordinator");
    if (
      ExtractionCoordinator.isExtractionInProgress(
        download.shop,
        download.objectId
      )
    ) {
      logger.info(
        `[DownloadManager] Skipping resumeSeeding for ${gameId} (extraction in progress)`
      );
      return;
    }

    const latest = await downloadsSublevel.get(gameId);
    if (latest?.extracting) {
      logger.info(
        `[DownloadManager] Skipping resumeSeeding for ${gameId} (extracting flag set)`
      );
      return;
    }

    await GoRPC.rpc.call("action", {
      action: "resume_seeding",
      game_id: gameId,
      url: download.uri,
      save_path: download.downloadPath,
    });
  }

  static async pauseSeeding(downloadKey: string) {
    await GoRPC.rpc.call("action", {
      action: "pause_seeding",
      game_id: downloadKey,
    });
  }

  /** Release torrent file handles on disk without deleting payload data. */
  static async releaseTorrentFiles(download: Download) {
    const gameId = levelKeys.game(download.shop, download.objectId);

    logger.info(
      `[DownloadManager] Releasing torrent file handles for ${gameId} (${download.folderName ?? "unknown"})`
    );

    try {
      // Call twice: first drop maps, second catches any re-attached handle from seed status polls.
      for (let pass = 0; pass < 2; pass++) {
        await GoRPC.rpc.call("action", {
          action: "release_files",
          game_id: gameId,
          url: download.uri ?? undefined,
          save_path: download.downloadPath,
          folder_name: download.folderName ?? undefined,
        });
      }
    } catch (error) {
      logger.error(
        "[DownloadManager] Failed to release torrent files for extraction",
        error
      );
      throw error;
    }
  }

  private static async getJsDownloadOptions(download: Download): Promise<{
    url: string;
    savePath: string;
    filename?: string;
    headers?: Record<string, string>;
  } | null> {
    const resumingFilename = download.folderName || undefined;

    switch (download.downloader) {
      case Downloader.Gofile:
        return this.getGofileDownloadOptions(download, resumingFilename);
      case Downloader.PixelDrain:
        return this.getPixelDrainDownloadOptions(download, resumingFilename);
      case Downloader.Datanodes:
        return this.getDatanodesDownloadOptions(download, resumingFilename);
      case Downloader.Buzzheavier:
        return this.getBuzzheavierDownloadOptions(download, resumingFilename);
      case Downloader.FuckingFast:
        return this.getFuckingFastDownloadOptions(download, resumingFilename);
      case Downloader.Mediafire:
        return this.getMediafireDownloadOptions(download, resumingFilename);
      case Downloader.RealDebrid:
        return this.getRealDebridDownloadOptions(download, resumingFilename);
      case Downloader.Premiumize:
        return this.getPremiumizeDownloadOptions(download, resumingFilename);
      case Downloader.AllDebrid:
        return this.getAllDebridDownloadOptions(download, resumingFilename);
      case Downloader.TorBox:
        return this.getTorBoxDownloadOptions(download, resumingFilename);
      case Downloader.VikingFile:
        return this.getVikingFileDownloadOptions(download, resumingFilename);
      case Downloader.Rootz:
        return this.getRootzDownloadOptions(download, resumingFilename);
      case Downloader.Http:
        return this.getHttpDownloadOptions(download, resumingFilename);
      default:
        return null;
    }
  }

  private static calculateAllDebridBatchProgress(
    batch: AllDebridBatchState,
    currentFileProgress: number,
    currentBytesDownloaded: number,
    currentFileSize: number
  ) {
    if (batch.totalBytes > 0) {
      const effectiveCurrentBytes =
        currentFileSize > 0
          ? currentFileSize * Math.max(0, Math.min(currentFileProgress, 1))
          : currentBytesDownloaded;
      return Math.min(
        (batch.completedBytes + effectiveCurrentBytes) / batch.totalBytes,
        1
      );
    }

    const totalEntries = Math.max(batch.entries.length, 1);
    return Math.min(
      (batch.currentIndex + Math.max(0, Math.min(currentFileProgress, 1))) /
        totalEntries,
      1
    );
  }

  private static async runAllDebridBatch() {
    while (this.allDebridBatch && this.jsDownloader) {
      const batch = this.allDebridBatch;
      const downloader = this.jsDownloader;
      const entry = batch.entries[batch.currentIndex];
      if (!entry) break;

      try {
        let resolvedUrl = entry.url;
        if (entry.isLocked) {
          resolvedUrl = await AllDebridClient.unlockDownloadLink(entry.url);
        }

        if (!this.allDebridBatch || !this.jsDownloader) break;

        const options = {
          url: resolvedUrl,
          savePath: batch.savePath,
          filename: this.sanitizeRelativePath(entry.filename),
        };

        this.logResolvedUrl(options.url);
        await downloader.startDownload(options);

        if (!this.allDebridBatch || !this.jsDownloader) break;

        const dlStatus = downloader.getDownloadStatus();
        if (
          !dlStatus ||
          dlStatus.status === "paused" ||
          dlStatus.status === "error"
        ) {
          break;
        }

        const expectedSize = entry.size ?? 0;
        if (
          expectedSize > 0 &&
          dlStatus.bytesDownloaded < expectedSize * 0.95
        ) {
          logger.error(
            `[DownloadManager] AllDebrid batch entry ${batch.currentIndex} size mismatch: ` +
              `downloaded=${dlStatus.bytesDownloaded} expected=${expectedSize}. ` +
              `The download URL may have returned an error page.`
          );
          this.cleanupBatch();
          return;
        }

        batch.completedBytes += Math.max(
          entry.size ?? 0,
          dlStatus.bytesDownloaded
        );
        batch.currentIndex += 1;
      } catch (err) {
        logger.error("[DownloadManager] AllDebrid batch entry error:", err);
        this.cleanupBatch();
        return;
      }
    }
  }

  private static cleanupBatch() {
    const batch = this.allDebridBatch;
    this.usingJsDownloader = false;
    this.jsDownloader?.cancelDownload();
    this.jsDownloader = null;
    this.allDebridBatch = null;
    this.downloadingGameId = null;
    this.isPreparingDownload = false;
    WindowManager.mainWindow?.setProgressBar(-1);
    WindowManager.sendToAppWindows("on-download-progress", null);

    if (batch?.gameId) {
      const gameId = batch.gameId;
      downloadsSublevel
        .get(gameId)
        .then((download) => {
          if (!download || download.status === "complete") return;
          return downloadsSublevel.put(gameId, {
            ...download,
            status: "error",
            queued: false,
            pinnedToHero: false,
          });
        })
        .then(() => {
          WindowManager.sendDownloadsUpdated();
          void this.processNextQueuedDownload();
        })
        .catch((err) => {
          logger.error(
            "[DownloadManager] Failed to persist batch error status",
            err
          );
        });
    }
  }

  private static async getGofileDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const { id, password } = this.parseGofileUri(download.uri);
    if (!id) {
      throw new Error("Invalid gofile URL");
    }

    const downloadLink = await GofileApi.getDownloadLink(id, password);
    await GofileApi.checkDownloadUrl(downloadLink);
    const token = await GofileApi.authorize();

    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadLink
    );
    return this.buildDownloadOptions(
      downloadLink,
      download.downloadPath,
      filename,
      { Cookie: `accountToken=${token}` }
    );
  }

  private static async getPixelDrainDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadUrl = await PixelDrainApi.unlock(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getDatanodesDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadUrl = await DatanodesApi.getDownloadUrl(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getBuzzheavierDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    logger.log(
      `[DownloadManager] Processing Buzzheavier download for URI: ${download.uri}`
    );
    const directUrl = await BuzzheavierApi.getDirectLink(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      directUrl
    );
    return this.buildDownloadOptions(
      directUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getFuckingFastDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    logger.log(
      `[DownloadManager] Processing FuckingFast download for URI: ${download.uri}`
    );
    const directUrl = await FuckingFastApi.getDirectLink(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      directUrl
    );
    return this.buildDownloadOptions(
      directUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getMediafireDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadUrl = await MediafireApi.getDownloadUrl(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getRealDebridDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadUrl = await RealDebridClient.getDownloadUrl(download.uri);
    if (!downloadUrl) throw new Error(DownloadError.NotCachedOnRealDebrid);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getPremiumizeDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadUrl = await PremiumizeClient.getDownloadUrl(download.uri);
    if (!downloadUrl) throw new Error(DownloadError.NotCachedOnPremiumize);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getAllDebridDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadInfo = await AllDebridClient.getDownloadInfo(download.uri);
    if (!downloadInfo?.url) throw new Error(DownloadError.NotCachedOnAllDebrid);
    const filename = resumingFilename
      ? this.sanitizeRelativePath(resumingFilename)
      : downloadInfo.filename
        ? this.sanitizeRelativePath(downloadInfo.filename)
        : this.resolveFilename(undefined, download.uri, downloadInfo.url);
    return this.buildDownloadOptions(
      downloadInfo.url,
      download.downloadPath,
      filename
    );
  }

  private static async getTorBoxDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const { name, url } = await TorBoxClient.getDownloadInfo(download.uri);
    if (!url) return null;
    return this.buildDownloadOptions(
      url,
      download.downloadPath,
      resumingFilename || name
    );
  }

  private static async getVikingFileDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    logger.log(
      `[DownloadManager] Processing VikingFile download for URI: ${download.uri}`
    );
    const downloadUrl = await VikingFileApi.getDownloadUrl(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getRootzDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const downloadUrl = await RootzApi.getDownloadUrl(download.uri);
    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      downloadUrl
    );
    return this.buildDownloadOptions(
      downloadUrl,
      download.downloadPath,
      filename
    );
  }

  private static async getHttpDownloadOptions(
    download: Download,
    resumingFilename?: string
  ) {
    const parsedUrl = new URL(download.uri);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Invalid HTTP download URL");
    }

    const filename = this.resolveFilename(
      resumingFilename,
      download.uri,
      download.uri
    );

    return this.buildDownloadOptions(
      download.uri,
      download.downloadPath,
      filename
    );
  }

  private static async getDownloadPayload(download: Download) {
    // Only Torrent downloader reaches this path — all other downloaders use the JS HTTP downloader.
    if (download.downloader !== Downloader.Torrent) return undefined;

    const downloadId = levelKeys.game(download.shop, download.objectId);
    const hasSelectedFileIndices =
      Array.isArray(download.fileIndices) && download.fileIndices.length > 0;

    // Go RPC accepts:
    // - magnet:  → fetch metadata from swarm (Hydra default)
    // - http(s)://*.torrent → download .torrent file then start (full metainfo)
    // - local path / metainfo_base64 → load metainfo immediately
    // Payload shape matches Hydra download-manager getDownloadPayload(Torrent).
    return {
      action: "start",
      game_id: downloadId,
      url: download.uri,
      save_path: download.downloadPath,
      file_indices: hasSelectedFileIndices ? download.fileIndices : undefined,
      metadata_timeout_ms: hasSelectedFileIndices ? 60_000 : undefined,
    };
  }

  static async validateDownloadUrl(download: Download): Promise<void> {
    const isHttp = this.isHttpDownloader(download.downloader);

    if (isHttp) {
      const options = await this.getJsDownloadOptions(download);
      if (!options) {
        throw new Error("Failed to validate download URL");
      }
    }
  }

  static async startDownload(download: Download) {
    const isHttp = this.isHttpDownloader(download.downloader);
    const downloadId = levelKeys.game(download.shop, download.objectId);

    if (isHttp) {
      logger.log("[DownloadManager] Using JS HTTP downloader");

      // Set preparing state immediately so UI knows download is starting
      this.downloadingGameId = downloadId;
      this.isPreparingDownload = true;
      this.usingJsDownloader = true;

      try {
        // Multi-file batch path (AllDebrid magnets, RealDebrid multi-link torrents)
        let batchEntries: Array<{
          url: string;
          filename: string;
          size?: number;
          isLocked?: boolean;
        }> | null = null;

        if (download.downloader === Downloader.AllDebrid) {
          const entries = await AllDebridClient.getDownloadEntries(
            download.uri
          );
          if (this.downloadingGameId !== downloadId) {
            this.isPreparingDownload = false;
            this.usingJsDownloader = false;
            return;
          }
          if (!entries?.length) {
            this.isPreparingDownload = false;
            this.usingJsDownloader = false;
            this.downloadingGameId = null;
            throw new Error(DownloadError.NotCachedOnAllDebrid);
          }
          batchEntries = entries.map((entry) => ({
            ...entry,
            filename: this.sanitizeRelativePath(entry.filename),
          }));
        } else if (
          download.downloader === Downloader.RealDebrid &&
          download.uri.startsWith("magnet:")
        ) {
          const entries = await RealDebridClient.getDownloadEntries(
            download.uri
          );
          if (this.downloadingGameId !== downloadId) {
            this.isPreparingDownload = false;
            this.usingJsDownloader = false;
            return;
          }
          if (!entries?.length) {
            this.isPreparingDownload = false;
            this.usingJsDownloader = false;
            this.downloadingGameId = null;
            throw new Error(DownloadError.NotCachedOnRealDebrid);
          }
          if (entries.length > 1) {
            batchEntries = entries.map((entry) => ({
              url: entry.url,
              filename: this.sanitizeRelativePath(entry.filename || "download"),
              isLocked: false,
            }));
          }
        }

        if (batchEntries && batchEntries.length > 0) {
          this.allDebridBatch = {
            downloadId,
            gameId: downloadId,
            savePath: download.downloadPath,
            entries: batchEntries,
            currentIndex: 0,
            completedBytes: 0,
            totalBytes: batchEntries.every(
              (item) => typeof item.size === "number"
            )
              ? batchEntries.reduce((acc, item) => acc + (item.size ?? 0), 0)
              : 0,
            lastSpeedUpdate: Date.now(),
            bytesAtLastSpeedUpdate: 0,
            batchSpeed: 0,
          };

          this.jsDownloader = new JsHttpDownloader();
          this.jsDownloader.setMaxDownloadSpeedBytesPerSecond(
            this.maxDownloadSpeedBytesPerSecond
          );
          this.isPreparingDownload = false;
          void this.runAllDebridBatch().catch(async (err) => {
            if (this.downloadingGameId !== downloadId) {
              return;
            }
            this.handlingJsErrorGameId = downloadId;
            await this.persistDownloadError(downloadId, download, err);
            this.clearRuntimeDownloadState();
            this.handlingJsErrorGameId = null;
            void this.processNextQueuedDownload();
          });
        } else {
          this.allDebridBatch = null;
          const options = await this.getJsDownloadOptions(download);

          if (this.downloadingGameId !== downloadId) {
            this.isPreparingDownload = false;
            this.usingJsDownloader = false;
            return;
          }

          if (!options) {
            this.isPreparingDownload = false;
            this.usingJsDownloader = false;
            this.downloadingGameId = null;
            throw new Error("Failed to get download options for JS downloader");
          }

          this.jsDownloader = new JsHttpDownloader();
          this.jsDownloader.setMaxDownloadSpeedBytesPerSecond(
            this.maxDownloadSpeedBytesPerSecond
          );
          this.isPreparingDownload = false;

          this.logResolvedUrl(options.url);
          this.jsDownloader.startDownload(options).catch(async (err) => {
            if (this.downloadingGameId !== downloadId) {
              return;
            }
            this.handlingJsErrorGameId = downloadId;
            await this.persistDownloadError(downloadId, download, err);
            this.clearRuntimeDownloadState();
            this.handlingJsErrorGameId = null;
            void this.processNextQueuedDownload();
          });
        }
      } catch (err) {
        if (this.downloadingGameId === downloadId) {
          this.isPreparingDownload = false;
          this.usingJsDownloader = false;
          this.downloadingGameId = null;
          this.allDebridBatch = null;
        }
        throw err;
      }
    } else {
      logger.log("[DownloadManager] Using Go RPC downloader");
      const payload = await this.getDownloadPayload(download);
      const isSelectiveTorrentStart =
        download.downloader === Downloader.Torrent &&
        Array.isArray(download.fileIndices) &&
        download.fileIndices.length > 0;

      const previousDownloadingGameId = this.downloadingGameId;
      const previousIsPreparingDownload = this.isPreparingDownload;
      const previousUsingJsDownloader = this.usingJsDownloader;
      const previousAllDebridBatch = this.allDebridBatch;

      this.downloadingGameId = downloadId;
      this.isPreparingDownload = true;
      this.usingJsDownloader = false;
      this.allDebridBatch = null;

      if (payload?.url) {
        this.logResolvedUrl(payload.url);
      }

      try {
        // Match Hydra PythonRPC: non-selective start returns almost immediately
        // (metadata continues in the torrent client). Selective waits for metadata.
        // 15s allows a short HTTP metainfo-cache probe (~3s) + AddTorrent without
        // the old 10s race that left downloads stuck at 0%/N/A after RPC timeout.
        await GoRPC.rpc.call("action", payload, {
          timeout: isSelectiveTorrentStart ? 60_000 : 15_000,
        });

        const downloadWasCancelledOrReplaced =
          this.downloadingGameId !== downloadId;

        if (downloadWasCancelledOrReplaced) {
          await GoRPC.rpc
            .call("action", { action: "cancel", game_id: downloadId })
            .catch((error) => {
              logger.error(
                "[DownloadManager] Failed to cancel stale torrent download",
                error
              );
            });
          return;
        }

        this.isPreparingDownload = false;
        this.rpcStatusFailures = 0;
      } catch (error) {
        if (this.downloadingGameId === downloadId) {
          this.downloadingGameId = previousDownloadingGameId;
          this.isPreparingDownload = previousIsPreparingDownload;
          this.usingJsDownloader = previousUsingJsDownloader;
          this.allDebridBatch = previousAllDebridBatch;
        }

        throw error;
      }
    }
  }
}
