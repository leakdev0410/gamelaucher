import { registerEvent } from "../register-event";
import { savesPath } from "@main/constants";
import { logger } from "@main/services";
import path from "node:path";
import fs from "node:fs";

// The artifact id is the local backup file name (see get-game-artifacts).
const deleteGameArtifact = async (
  _event: Electron.IpcMainInvokeEvent,
  gameArtifactId: string
): Promise<{ ok: boolean }> => {
  const filePath = path.join(savesPath, gameArtifactId);

  // Guard against path traversal: the resolved file must stay inside savesPath.
  const resolvedSaves = path.resolve(savesPath);
  if (!path.resolve(filePath).startsWith(resolvedSaves + path.sep)) {
    return { ok: false };
  }

  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    return { ok: true };
  } catch (error) {
    logger.error("Failed to delete local save artifact", { filePath, error });
    return { ok: false };
  }
};

registerEvent("deleteGameArtifact", deleteGameArtifact);
