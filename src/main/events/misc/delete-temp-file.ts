import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { registerEvent } from "../register-event";

const deleteTempFile = async (
  _event: Electron.IpcMainInvokeEvent,
  filePath: string
): Promise<void> => {
  try {
    const tempDirectory = path.resolve(app.getPath("temp"));
    const resolvedPath = path.resolve(filePath);
    const allowedPrefix = `${tempDirectory}${path.sep}`;

    // Only files created by saveTempFile may be removed through this bridge.
    if (
      !resolvedPath.startsWith(allowedPrefix) ||
      !path.basename(resolvedPath).startsWith("gl-temp-")
    ) {
      throw new Error("Refusing to delete a file outside the app temp scope");
    }

    if (fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  } catch (error) {
    // Silently fail - temp files will be cleaned up by OS eventually
    console.warn(`Failed to delete temp file: ${error}`);
  }
};

registerEvent("deleteTempFile", deleteTempFile);
