import { appVersion, defaultDownloadsPath, isStaging } from "@main/constants";
import { registerEvent } from "./register-event";

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

registerEvent("ping", () => "pong");
registerEvent("getVersion", () => appVersion);
registerEvent("isStaging", () => isStaging);
registerEvent("isPortableVersion", () => isPortableVersion());
registerEvent("getDefaultDownloadsPath", () => {
  // Ensure portable `<exe>/game` exists before the UI reads the path.
  return ensureDefaultGameFolder() || defaultDownloadsPath;
});
