import fs from "node:fs";
import path from "node:path";

import { registerEvent } from "../register-event";
import { ensureDownloadsPathExists } from "@main/helpers/ensure-downloads-path";

const checkFolderWritePermission = async (
  _event: Electron.IpcMainInvokeEvent,
  testPath: string
) => {
  if (!testPath?.trim()) return false;

  // Create the folder first (e.g. portable default `<exe>/game` on first run).
  if (!ensureDownloadsPathExists(testPath)) {
    return false;
  }

  const testFilePath = path.join(testPath, ".gl-write-test");

  try {
    fs.writeFileSync(testFilePath, "");
    fs.rmSync(testFilePath);
    return true;
  } catch {
    return false;
  }
};

registerEvent("checkFolderWritePermission", checkFolderWritePermission);
