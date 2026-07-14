import { registerEvent } from "../register-event";
import type { Download, StartGameDownloadPayload } from "@types";
import {
  DownloadManager,
  DownloadOrchestrator,
  ApiClient,
  logger,
} from "@main/services";
import { createGame } from "@main/services/library-sync";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import {
  handleDownloadError,
  isKnownDownloadError,
  prepareGameEntry,
} from "@main/helpers";
import { ensureDownloadsPathExists } from "@main/helpers/ensure-downloads-path";

const startGameDownload = async (
  _event: Electron.IpcMainInvokeEvent,
  payload: StartGameDownloadPayload
) => {
  const {
    objectId,
    title,
    shop,
    downloadPath,
    downloader,
    uri,
    automaticallyExtract,
    automaticallyDeleteArchiveFiles,
    fileIndices,
    selectedFilesSize,
  } = payload;

  const gameKey = levelKeys.game(shop, objectId);

  logger.log(
    `[Downloads] Start requested for ${gameKey} (downloader=${downloader})`
  );

  // Create download folder if missing (portable `game/` on first install).
  if (!ensureDownloadsPathExists(downloadPath)) {
    return {
      ok: false as const,
      error: "download_path_not_writable",
    };
  }

  await prepareGameEntry({ gameKey, title, objectId, shop });
  await DownloadManager.cancelDownload(gameKey);

  const download: Download = {
    shop,
    objectId,
    status: "paused",
    progress: 0,
    bytesDownloaded: 0,
    downloadPath,
    downloader,
    uri,
    folderName: null,
    shouldSeed: false,
    timestamp: Date.now(),
    queued: true,
    pinnedToHero: false,
    extracting: false,
    automaticallyExtract,
    automaticallyDeleteArchiveFiles,
    fileIndices,
    selectedFilesSize,
    fileSize: selectedFilesSize ?? null,
  };

  try {
    await downloadsSublevel.put(gameKey, download);
    await DownloadOrchestrator.startPreparedDownload(download);

    const updatedGame = await gamesSublevel.get(gameKey);

    await Promise.all([
      createGame(updatedGame!).catch(() => {}),
      ApiClient.post(`/games/${shop}/${objectId}/download`, null, {
        needsAuth: false,
      }).catch(() => {}),
    ]);

    return { ok: true };
  } catch (err: unknown) {
    await downloadsSublevel.del(gameKey).catch(() => null);
    await DownloadOrchestrator.syncAfterDownloadRemoved({ shop, objectId });

    if (isKnownDownloadError(err)) {
      logger.warn("Failed to start download with expected download error", err);
    } else {
      logger.error("Failed to start download", err);
    }
    return handleDownloadError(err, downloader);
  }
};

registerEvent("startGameDownload", startGameDownload);
