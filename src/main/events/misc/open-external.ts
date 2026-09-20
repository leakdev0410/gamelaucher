import { shell } from "electron";
import { registerEvent } from "../register-event";

const openExternal = async (
  _event: Electron.IpcMainInvokeEvent,
  src: string
) => {
  const target = new URL(src);
  if (target.protocol !== "https:") {
    throw new Error("Only HTTPS URLs may be opened externally");
  }

  await shell.openExternal(target.toString());
};

registerEvent("openExternal", openExternal);
