import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { registerEvent } from "../register-event";
import { resolvePathWithinRoot } from "@main/helpers/path-within-root";

const saveTempFile = async (
  _event: Electron.IpcMainInvokeEvent,
  fileName: string,
  fileData: Uint8Array
): Promise<string> => {
  try {
    const tempDir = app.getPath("temp");
    const safeFileName = path.basename(fileName);
    if (!safeFileName || safeFileName === "." || safeFileName === "..") {
      throw new Error("Invalid temporary file name");
    }

    const tempFilePath = path.join(
      tempDir,
      `gl-temp-${Date.now()}-${safeFileName}`
    );
    const safeTempFilePath = resolvePathWithinRoot(tempDir, tempFilePath);
    if (!safeTempFilePath) {
      throw new Error("Temporary file path escapes the temp directory");
    }

    // Write the file data to temp directory
    fs.writeFileSync(safeTempFilePath, fileData);

    return safeTempFilePath;
  } catch (error) {
    throw new Error(`Failed to save temp file: ${error}`);
  }
};

registerEvent("saveTempFile", saveTempFile);
