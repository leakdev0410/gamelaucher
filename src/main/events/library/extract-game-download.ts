import { registerEvent } from "../register-event";
import { ExtractionCoordinator } from "@main/services/extraction-coordinator";
import type { GameShop } from "@types";

const extractGameDownload = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string
): Promise<boolean> => ExtractionCoordinator.runByKey(shop, objectId);

registerEvent("extractGameDownload", extractGameDownload);