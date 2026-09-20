import { registerEvent } from "../register-event";
import { addWindowsDefenderExclusion } from "@main/services";
import { executableBaseDir } from "@main/constants";

const addDefenderExclusion = async (_event: Electron.IpcMainInvokeEvent) => {
  return addWindowsDefenderExclusion(executableBaseDir);
};

registerEvent("addDefenderExclusion", addDefenderExclusion);
