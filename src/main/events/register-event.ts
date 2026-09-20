/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipcMain } from "electron";
import { app } from "electron";

/**
 * Do not treat the preload bridge as an authentication boundary.  Every
 * handler must reject calls made by navigated, embedded, or otherwise
 * untrusted renderer content before it touches local state.
 */
const isTrustedRenderer = (event: Electron.IpcMainInvokeEvent) => {
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl) return false;

  if (app.isPackaged) {
    try {
      const parsed = new URL(senderUrl);
      return (
        parsed.protocol === "file:" &&
        decodeURI(parsed.pathname).endsWith("/renderer/index.html")
      );
    } catch {
      return false;
    }
  }

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  return Boolean(devUrl && senderUrl.startsWith(devUrl));
};

export const registerEvent = (
  name: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
) => {
  ipcMain.handle(name, async (event: Electron.IpcMainInvokeEvent, ...args) => {
    if (!isTrustedRenderer(event)) {
      throw new Error(`Rejected IPC request from untrusted renderer: ${name}`);
    }

    return Promise.resolve(listener(event, ...args)).then((result) => {
      if (!result) return result;
      return JSON.parse(JSON.stringify(result));
    });
  });
};
