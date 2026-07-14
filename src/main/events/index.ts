import { appVersion, defaultDownloadsPath, isStaging } from "@main/constants";
import { ipcMain } from "electron";

import "./auth";
import "./catalogue";
import "./cloud-save";
import "./download-sources";
import "./hardware";
import "./library";
import "./leveldb";
import "./misc";
import "./notifications";
import "./profile";
import "./themes";
import "./torrenting";
import "./user";
import "./user-preferences";
import "./library/transfer-game-files";

import { isPortableVersion } from "@main/helpers";
import { ensureDefaultGameFolder } from "@main/helpers/ensure-downloads-path";

ipcMain.handle("ping", () => "pong");
ipcMain.handle("getVersion", () => appVersion);
ipcMain.handle("isStaging", () => isStaging);
ipcMain.handle("isPortableVersion", () => isPortableVersion());
ipcMain.handle("getDefaultDownloadsPath", () => {
  // Ensure portable `<exe>/game` exists before the UI reads the path.
  return ensureDefaultGameFolder() || defaultDownloadsPath;
});
