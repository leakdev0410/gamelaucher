import { app } from "electron";
import path from "node:path";
import { SystemPath } from "./services/system-path";
import { appConfig } from "@shared";

// Base directory that travels with the app. For a portable build the app runs
// from a temp extraction dir, so we use PORTABLE_EXECUTABLE_DIR (set by
// electron-builder) to reach the real .exe location; for an installed build we
// use the install dir, and in dev the project root.
export const executableBaseDir =
  process.env.PORTABLE_EXECUTABLE_DIR ??
  (app.isPackaged ? path.dirname(app.getPath("exe")) : process.cwd());

// Default download location: a "game" folder next to the executable. The HTTP
// downloader creates it (mkdir recursive) on first use.
export const defaultDownloadsPath = path.join(executableBaseDir, "game");

export const isStaging = appConfig.apiUrl.includes("staging");

export const windowsStartMenuPath = path.join(
  SystemPath.getPath("appData"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs"
);

export const publicProfilePath = "C:/Users/Public";

// Settings + library database stored next to the executable (portable) at
// <exe>/save/dp instead of the system userData folder.
export const levelDatabasePath = path.join(
  executableBaseDir,
  "save",
  `dp${isStaging ? "-staging" : ""}`
);

export const commonRedistPath = path.join(
  SystemPath.getPath("userData"),
  "CommonRedist"
);

export const logsPath = path.join(
  SystemPath.getPath("userData"),
  `logs${isStaging ? "-staging" : ""}`
);

export const achievementSoundPath = app.isPackaged
  ? path.join(process.resourcesPath, "achievement.wav")
  : path.join(__dirname, "..", "..", "resources", "achievement.wav");

export const backupsPath = path.join(SystemPath.getPath("userData"), "Backups");

// Local save game folder next to the executable so saves travel with the app.
export const savesPath = path.join(executableBaseDir, "save");

export const appVersion = app.getVersion() + (isStaging ? "-staging" : "");

export const ASSETS_PATH = path.join(SystemPath.getPath("userData"), "Assets");

export const THEMES_PATH = path.join(SystemPath.getPath("userData"), "themes");

export const INTERVALS = {
  processWatcher: 2_000,
  downloadWatcher: 2_000,
  achievementWatcher: 2_000,
  seedStatusWatcher: 2_000,
  updateChecker: 60_000 * 50, // 50 minutes
  powerSaveBlockerSync: 20_000,
};

export const DEFAULT_ACHIEVEMENT_SOUND_VOLUME = 0.15;
