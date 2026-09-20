import { registerEvent } from "../register-event";
import { executableBaseDir } from "@main/constants";

const getDefenderExclusionPath = async (
  _event: Electron.IpcMainInvokeEvent
) => {
  return executableBaseDir;
};

registerEvent("getDefenderExclusionPath", getDefenderExclusionPath);
