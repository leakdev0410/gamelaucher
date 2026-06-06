import { registerEvent } from "../register-event";
import type { GameArtifact, GameShop } from "@types";
import { savesPath } from "@main/constants";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Local save backups are a single tar per game stored next to the executable
// (see CloudSync.uploadSaveGame). We expose it as a one-item artifact list so
// the existing UI can list/restore/delete it.
const getGameArtifacts = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop
): Promise<GameArtifact[]> => {
  const fileName = `${shop}-${objectId}.tar`;
  const filePath = path.join(savesPath, fileName);

  if (!fs.existsSync(filePath)) return [];

  const stat = await fs.promises.stat(filePath);

  return [
    {
      id: fileName,
      artifactLengthInBytes: stat.size,
      downloadOptionTitle: null,
      createdAt: stat.mtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      hostname: os.hostname(),
      downloadCount: 0,
      isFrozen: false,
    },
  ];
};

registerEvent("getGameArtifacts", getGameArtifacts);
