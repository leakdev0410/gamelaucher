import path from "node:path";
import fs from "node:fs";

import { registerEvent } from "../register-event";
import { logger } from "@main/services/logger";
import { downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import { resolvePathWithinRoot } from "@main/helpers/path-within-root";

export const deleteArchiveFile = async (filePath: string) => {
  try {
    const normalizedPath = path.resolve(filePath);
    const downloads = await downloadsSublevel.values().all();
    let matchingDownload: (typeof downloads)[number] | undefined;

    for (const download of downloads) {
      if (!download.folderName) continue;

      const downloadPath = path.resolve(
        path.join(download.downloadPath, download.folderName)
      );

      if (resolvePathWithinRoot(downloadPath, normalizedPath)) {
        matchingDownload = download;
        break;
      }
    }

    if (!matchingDownload) {
      throw new Error(
        "Refusing to delete a file that is not a tracked archive"
      );
    }

    if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isFile()) {
      await fs.promises.unlink(normalizedPath);
      logger.info(`Deleted archive: ${normalizedPath}`);
    }

    const gameKey = levelKeys.game(
      matchingDownload.shop,
      matchingDownload.objectId
    );
    const game = await gamesSublevel.get(gameKey);
    if (game) {
      await gamesSublevel.put(gameKey, {
        ...game,
        installerSizeInBytes: null,
      });
    }

    return true;
  } catch (err) {
    logger.error(`Failed to delete archive: ${filePath}`, err);
    return false;
  }
};

const deleteArchive = async (
  _event: Electron.IpcMainInvokeEvent,
  filePath: string
) => deleteArchiveFile(filePath);

registerEvent("deleteArchive", deleteArchive);
