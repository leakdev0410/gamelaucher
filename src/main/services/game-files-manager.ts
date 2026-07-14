import { ASSETS_PATH } from "@main/constants";
import { getGameAssets } from "@main/events/catalogue/get-game-assets";
import { getDirectorySize } from "@main/events/helpers/get-directory-size";
import { db, downloadsSublevel, gamesSublevel, levelKeys } from "@main/level";
import {
  Downloader,
  getArchiveExtractionRelativePath,
  isArchiveFile,
  isFirstArchiveVolume,
  REPACK_ARCHIVE_PASSWORDS,
  removeSymbolsFromName,
} from "@shared";
import type { GameShop, UserPreferences } from "@types";
import axios from "axios";
import createDesktopShortcut from "create-desktop-shortcuts";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";
import { ExtractionProgress, SevenZip } from "./7zip";
import { getPathType } from "./extraction-path";
import { GameExecutables } from "./game-executables";
import { logger } from "./logger";
import { deleteArchiveFile } from "@main/events/library/delete-archive";
import { publishExtractionCompleteNotification } from "./notifications";
import { SystemPath } from "./system-path";
import { WindowManager } from "./window-manager";

const PROGRESS_THROTTLE_MS = 1000;

export class GameFilesManager {
  private lastProgressUpdateTime = 0;
  private lastProgressUpdateValue = 0;

  constructor(
    private readonly shop: GameShop,
    private readonly objectId: string
  ) {}

  private get gameKey() {
    return levelKeys.game(this.shop, this.objectId);
  }

  private updateExtractionProgress(progress: number, force = false) {
    const now = Date.now();

    if (!force && now - this.lastProgressUpdateTime < PROGRESS_THROTTLE_MS) {
      return;
    }

    if (!force && progress < this.lastProgressUpdateValue) {
      return;
    }

    this.lastProgressUpdateValue = progress;
    this.lastProgressUpdateTime = now;

    WindowManager.sendToAppWindows(
      "on-extraction-progress",
      this.shop,
      this.objectId,
      progress
    );
  }

  private async setExtractionFailedState(error: unknown, targetPath?: string) {
    logger.error(
      `[GameFilesManager] Extraction failed for ${this.objectId}${targetPath ? ` at ${targetPath}` : ""}`,
      error
    );

    const download = await downloadsSublevel.get(this.gameKey);

    if (download) {
      const status =
        download.progress === 1
          ? download.shouldSeed && download.downloader === Downloader.Torrent
            ? "seeding"
            : "complete"
          : download.status;

      await downloadsSublevel.put(this.gameKey, {
        ...download,
        status,
        queued: false,
        extracting: false,
      });
      WindowManager.sendDownloadsUpdated();
    }

    WindowManager.sendToAppWindows(
      "on-extraction-failed",
      this.shop,
      this.objectId
    );

    this.lastProgressUpdateTime = 0;
    this.lastProgressUpdateValue = 0;
  }

  async failExtraction(error: unknown, targetPath?: string) {
    await this.setExtractionFailedState(error, targetPath);
  }

  static async findArchivePathsInDirectory(
    directoryPath: string
  ): Promise<string[]> {
    const entries = await fs.promises.readdir(directoryPath, {
      withFileTypes: true,
    });

    const archiveFilePaths: string[] = [];

    for (const entry of entries) {
      if (entry.isFile() && isArchiveFile(entry.name)) {
        archiveFilePaths.push(path.join(directoryPath, entry.name));
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const subdirectoryPath = path.join(directoryPath, entry.name);
      const subdirectoryEntries = await fs.promises.readdir(subdirectoryPath, {
        withFileTypes: true,
      });

      for (const subdirectoryEntry of subdirectoryEntries) {
        if (subdirectoryEntry.isFile() && isArchiveFile(subdirectoryEntry.name)) {
          archiveFilePaths.push(
            path.join(subdirectoryPath, subdirectoryEntry.name)
          );
        }
      }
    }

    const archivesWithSize = await Promise.all(
      archiveFilePaths.map(async (archivePath) => {
        try {
          const { size } = await fs.promises.stat(archivePath);
          return { archivePath, size };
        } catch {
          return { archivePath, size: 0 };
        }
      })
    );

    return archivesWithSize
      .sort((left, right) => {
        if (right.size !== left.size) {
          return right.size - left.size;
        }

        return left.archivePath.localeCompare(right.archivePath, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      })
      .map(({ archivePath }) => archivePath);
  }

  private async getArchiveFilePaths(directoryPath: string): Promise<string[]> {
    return GameFilesManager.findArchivePathsInDirectory(directoryPath);
  }

  private readonly handleProgress = (progress: ExtractionProgress) => {
    logger.log(`handleProgress: ${progress.percent}% - ${progress.file}`);
    this.updateExtractionProgress(progress.percent / 100);
  };

  /**
   * Extract archives under a directory. Throws on failure so
   * {@link ExtractionCoordinator} can retry without clearing the extracting flag.
   */
  async extractFilesInDirectory(directoryPath: string): Promise<boolean> {
    const pathType = await getPathType(directoryPath);

    if (pathType !== "directory") {
      throw new Error(
        `Expected extraction directory but got "${pathType}" for ${directoryPath}`
      );
    }

    let archivePaths = await this.getArchiveFilePaths(directoryPath);

    const filesToExtract = archivePaths.filter((archivePath) =>
      isFirstArchiveVolume(path.basename(archivePath))
    );

    if (archivePaths.length === 0) return true;

    if (filesToExtract.length === 0) {
      throw new Error("No first archive volume was found to extract");
    }

    this.updateExtractionProgress(0, true);

    const totalFiles = filesToExtract.length;
    let completedFiles = 0;

    for (const archivePath of filesToExtract) {
      const archiveDirectory = path.dirname(archivePath);
      const result = await SevenZip.extractFile(
        {
          filePath: archivePath,
          cwd: archiveDirectory,
          passwords: [...REPACK_ARCHIVE_PASSWORDS],
        },
        (progress) => {
          const overallProgress =
            (completedFiles + progress.percent / 100) / totalFiles;
          this.updateExtractionProgress(overallProgress);
        }
      );

      if (!result.success) {
        throw new Error(
          `7zip returned unsuccessful extraction for ${archivePath}`
        );
      }

      completedFiles++;
      this.updateExtractionProgress(completedFiles / totalFiles, true);
    }

    archivePaths = archivePaths.filter((archivePath) =>
      fs.existsSync(archivePath)
    );

    if (archivePaths.length > 0) {
      const [download, userPreferences] = await Promise.all([
        downloadsSublevel.get(this.gameKey),
        db.get<string, UserPreferences | null>(levelKeys.userPreferences, {
          valueEncoding: "json",
        }),
      ]);

      const shouldDelete =
        download?.automaticallyDeleteArchiveFiles ??
        userPreferences?.deleteArchiveFilesAfterExtractionByDefault ??
        false;

      if (shouldDelete) {
        for (const archivePath of archivePaths) {
          await deleteArchiveFile(archivePath);
        }
      } else {
        WindowManager.sendToAppWindows(
          "on-archive-deletion-prompt",
          archivePaths
        );
      }
    }

    return true;
  }

  async setExtractionComplete(publishNotification = true) {
    const [download, game] = await Promise.all([
      downloadsSublevel.get(this.gameKey),
      gamesSublevel.get(this.gameKey),
    ]);

    if (!download) return;

    await downloadsSublevel.put(this.gameKey, {
      ...download,
      extracting: false,
    });
    WindowManager.sendDownloadsUpdated();

    // Calculate and store the installed size
    if (game && download.folderName) {
      const gamePath = path.join(download.downloadPath, download.folderName);
      const installedSizeInBytes = await getDirectorySize(gamePath);

      await gamesSublevel.put(this.gameKey, {
        ...game,
        installedSizeInBytes,
      });
    }

    WindowManager.sendToAppWindows(
      "on-extraction-complete",
      this.shop,
      this.objectId
    );

    if (publishNotification && game) {
      publishExtractionCompleteNotification(game);
    }

    this.lastProgressUpdateTime = 0;
    this.lastProgressUpdateValue = 0;

    await this.searchAndBindExecutable();
  }

  async searchAndBindExecutable(): Promise<void> {
    try {
      const [download, game] = await Promise.all([
        downloadsSublevel.get(this.gameKey),
        gamesSublevel.get(this.gameKey),
      ]);

      if (!download || !game || game.executablePath) {
        return;
      }

      const executableNames = GameExecutables.getExecutablesForGame(
        this.objectId
      );

      if (!executableNames || executableNames.length === 0) {
        return;
      }

      if (!download.folderName) {
        return;
      }

      const gameFolderPath = path.join(
        download.downloadPath,
        download.folderName
      );

      if (!fs.existsSync(gameFolderPath)) {
        return;
      }

      const foundExePath = await this.findExecutableInFolder(
        gameFolderPath,
        executableNames
      );

      if (foundExePath) {
        logger.info(
          `[GameFilesManager] Auto-detected executable for ${this.objectId}: ${foundExePath}`
        );

        await gamesSublevel.put(this.gameKey, {
          ...game,
          executablePath: foundExePath,
        });

        WindowManager.sendToAppWindows("on-library-batch-complete");

        await this.createDesktopShortcutForGame(game.title);
      }
    } catch (err) {
      logger.error(
        `[GameFilesManager] Error searching for executable: ${this.objectId}`,
        err
      );
    }
  }

  private isValidHttpUrl(url: string | null | undefined): url is string {
    return !!url && (url.startsWith("http://") || url.startsWith("https://"));
  }

  private isIcoUrl(url: string): boolean {
    return url.toLowerCase().endsWith(".ico");
  }

  private async downloadGameIcon(): Promise<string | null> {
    if (this.shop === "custom") {
      return null;
    }

    const iconDir = path.join(ASSETS_PATH, `${this.shop}-${this.objectId}`);
    const iconPath = path.join(iconDir, "icon.ico");

    try {
      if (fs.existsSync(iconPath)) {
        return iconPath;
      }
    } catch {
      // Ignore fs errors
    }

    const game = await gamesSublevel.get(this.gameKey);
    const assets = await getGameAssets(this.objectId, this.shop);

    const iconUrls = [
      assets?.iconUrl,
      game?.iconUrl,
      assets?.coverImageUrl,
    ].filter(this.isValidHttpUrl);

    if (iconUrls.length === 0) {
      logger.warn(
        `[GameFilesManager] No valid icon URLs found for: ${this.objectId}`
      );
      return null;
    }

    fs.mkdirSync(iconDir, { recursive: true });

    for (const iconUrl of iconUrls) {
      try {
        logger.log(
          `[GameFilesManager] Trying to download icon from: ${iconUrl}`
        );
        const response = await axios.get(iconUrl, {
          responseType: "arraybuffer",
        });
        const imageBuffer = Buffer.from(response.data);

        // If source is already ICO, use it directly
        if (this.isIcoUrl(iconUrl)) {
          fs.writeFileSync(iconPath, imageBuffer);
          logger.log(`[GameFilesManager] Copied ICO directly to: ${iconPath}`);
          return iconPath;
        }

        // Convert to square PNG (256x256 is standard for ICO), then to ICO
        const pngBuffer = await sharp(imageBuffer)
          .resize(256, 256, { fit: "cover" })
          .png()
          .toBuffer();
        const icoBuffer = await pngToIco(pngBuffer);
        fs.writeFileSync(iconPath, icoBuffer);

        logger.log(
          `[GameFilesManager] Successfully created icon at: ${iconPath}`
        );
        return iconPath;
      } catch (error) {
        logger.warn(
          `[GameFilesManager] Failed to convert icon from ${iconUrl}:`,
          error
        );
      }
    }

    logger.error(
      `[GameFilesManager] Failed to download/convert icon from any source: ${this.objectId}`
    );
    return null;
  }

  private createUrlShortcut(
    shortcutPath: string,
    url: string,
    iconPath?: string | null
  ): boolean {
    try {
      fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });

      if (fs.existsSync(shortcutPath)) {
        fs.unlinkSync(shortcutPath);
      }

      let content = `[InternetShortcut]\nURL=${url}\n`;

      if (iconPath) {
        content += `IconFile=${iconPath}\nIconIndex=0\n`;
      }

      fs.writeFileSync(shortcutPath, content);
      return true;
    } catch (error) {
      logger.error(
        `[GameFilesManager] Failed to create URL shortcut: ${this.objectId}`,
        error
      );
      return false;
    }
  }

  private deleteShortcutIfExists(shortcutPath: string) {
    try {
      if (fs.existsSync(shortcutPath)) {
        fs.unlinkSync(shortcutPath);
      }
    } catch (error) {
      logger.warn(
        `[GameFilesManager] Failed to delete existing shortcut: ${shortcutPath}`,
        error
      );
    }
  }

  private buildRunDeepLink() {
    const query = new URLSearchParams({
      shop: this.shop,
      objectId: this.objectId,
    });

    return `hydralauncher://run?${query.toString()}`;
  }

  private quoteLinuxExecArg(value: string) {
    return `"${value.replaceAll('"', '\\"')}"`;
  }

  private getShortcutArguments(deepLink: string) {
    const deepLinkArgument =
      process.platform === "linux"
        ? this.quoteLinuxExecArg(deepLink)
        : deepLink;

    if (process.defaultApp && process.argv.length >= 2) {
      const appEntry = path.resolve(process.argv[1]);
      const appEntryArgument =
        process.platform === "linux"
          ? this.quoteLinuxExecArg(appEntry)
          : appEntry;

      return `${appEntryArgument} ${deepLinkArgument}`;
    }

    return deepLinkArgument;
  }

  private createWindowsShortcut(
    shortcutName: string,
    outputPath: string,
    deepLink: string,
    iconPath?: string | null
  ): boolean {
    fs.mkdirSync(outputPath, { recursive: true });

    const linkPath = path.join(outputPath, `${shortcutName}.lnk`);
    const urlPath = path.join(outputPath, `${shortcutName}.url`);

    this.deleteShortcutIfExists(linkPath);
    this.deleteShortcutIfExists(urlPath);

    const windowVbsPath = app.isPackaged
      ? path.join(process.resourcesPath, "windows.vbs")
      : undefined;

    const nativeShortcutCreated = createDesktopShortcut({
      windows: {
        filePath: process.execPath,
        arguments: deepLink,
        name: shortcutName,
        outputPath,
        icon: iconPath ?? process.execPath,
        VBScriptPath: windowVbsPath,
      },
    });

    if (nativeShortcutCreated) {
      return true;
    }

    return this.createUrlShortcut(
      urlPath,
      deepLink,
      iconPath ?? process.execPath
    );
  }

  private async createDesktopShortcutForGame(gameTitle: string): Promise<void> {
    try {
      const shortcutName =
        removeSymbolsFromName(gameTitle).trim() || this.objectId;
      const deepLink = this.buildRunDeepLink();
      const shortcutArguments = this.getShortcutArguments(deepLink);
      const iconPath = await this.downloadGameIcon();

      if (process.platform === "win32") {
        const userPreferences = await db.get<string, UserPreferences | null>(
          levelKeys.userPreferences,
          { valueEncoding: "json" }
        );

        const shouldCreateDownloadShortcuts =
          userPreferences?.createStartMenuShortcut ?? true;

        if (!shouldCreateDownloadShortcuts) {
          return;
        }

        const desktopSuccess = this.createWindowsShortcut(
          shortcutName,
          SystemPath.getPath("desktop"),
          deepLink,
          iconPath
        );

        if (desktopSuccess) {
          logger.info(
            `[GameFilesManager] Created desktop shortcut for ${this.objectId}`
          );
        }

        const startMenuPath = path.join(
          SystemPath.getPath("appData"),
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs"
        );

        const startMenuSuccess = this.createWindowsShortcut(
          shortcutName,
          startMenuPath,
          deepLink,
          iconPath
        );

        if (startMenuSuccess) {
          logger.info(
            `[GameFilesManager] Created Start Menu shortcut for ${this.objectId}`
          );
        }
      } else {
        const windowVbsPath = app.isPackaged
          ? path.join(process.resourcesPath, "windows.vbs")
          : undefined;

        const options = {
          filePath: process.execPath,
          arguments: shortcutArguments,
          name: shortcutName,
          outputPath: SystemPath.getPath("desktop"),
          icon: iconPath ?? undefined,
        };

        const desktopSuccess = createDesktopShortcut({
          windows: { ...options, VBScriptPath: windowVbsPath },
          linux: options,
          osx: options,
        });

        if (desktopSuccess) {
          logger.info(
            `[GameFilesManager] Created desktop shortcut for ${this.objectId}`
          );
        }
      }
    } catch (err) {
      logger.error(
        `[GameFilesManager] Error creating desktop shortcut: ${this.objectId}`,
        err
      );
    }
  }

  private async findExecutableInFolder(
    folderPath: string,
    executableNames: string[]
  ): Promise<string | null> {
    const normalizedNames = new Set(
      executableNames.map((name) => name.toLowerCase())
    );

    try {
      const entries = await fs.promises.readdir(folderPath, {
        withFileTypes: true,
        recursive: true,
      });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const fileName = entry.name.toLowerCase();

        if (normalizedNames.has(fileName)) {
          const parentPath =
            "parentPath" in entry
              ? entry.parentPath
              : (entry as unknown as { path?: string }).path || folderPath;

          return path.join(parentPath, entry.name);
        }
      }
    } catch {
      // Silently fail if folder cannot be read
    }

    return null;
  }

  /**
   * Extract a single top-level archive file. Throws on failure so the
   * coordinator can retry without emitting a final failure state mid-loop.
   */
  async extractDownloadedFile(): Promise<boolean> {
    const [download, game] = await Promise.all([
      downloadsSublevel.get(this.gameKey),
      gamesSublevel.get(this.gameKey),
    ]);

    if (!download || !game) {
      throw new Error("Download or game metadata is missing for extraction");
    }

    if (!download.folderName) {
      throw new Error("No downloaded archive was found to extract");
    }

    const filePath = path.join(download.downloadPath, download.folderName);

    const extractionFolderName = getArchiveExtractionRelativePath(
      download.folderName
    );
    const extractionPath = path.join(
      download.downloadPath,
      extractionFolderName
    );

    this.updateExtractionProgress(0, true);

    const result = await SevenZip.extractFile(
      {
        filePath,
        outputPath: extractionPath,
        passwords: [...REPACK_ARCHIVE_PASSWORDS],
      },
      this.handleProgress
    );

    if (!result.success) {
      throw new Error(`7zip returned unsuccessful extraction for ${filePath}`);
    }

    await this.extractFilesInDirectory(extractionPath);

    if (fs.existsSync(extractionPath) && fs.existsSync(filePath)) {
      const userPreferences = await db.get<string, UserPreferences | null>(
        levelKeys.userPreferences,
        { valueEncoding: "json" }
      );

      const shouldDelete =
        download.automaticallyDeleteArchiveFiles ??
        userPreferences?.deleteArchiveFilesAfterExtractionByDefault ??
        false;

      if (shouldDelete) {
        await deleteArchiveFile(filePath);
      } else {
        WindowManager.sendToAppWindows("on-archive-deletion-prompt", [
          filePath,
        ]);
      }
    }

    await downloadsSublevel.put(this.gameKey, {
      ...download,
      folderName: extractionFolderName,
    });

    await this.setExtractionComplete();
    return true;
  }
}
