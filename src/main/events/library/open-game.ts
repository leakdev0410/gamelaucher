import { registerEvent } from "../register-event";
import { GameShop } from "@types";

const openGame = async (
  _event: Electron.IpcMainInvokeEvent,
  shop: GameShop,
  objectId: string,
  executablePath: string,
  launchOptions?: string | null
) => {
  const { launchGame } = await import("@main/helpers/launch-game");

  await launchGame({ shop, objectId, executablePath, launchOptions });
};

registerEvent("openGame", openGame);
