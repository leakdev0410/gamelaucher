// Install Cloudflare DNS (1.1.1.1) before any other main-process network import.
import "./services/cloudflare-dns";

import { app, BrowserWindow, dialog, net, protocol } from "electron";
import i18n from "i18next";
import path from "node:path";
import url from "node:url";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import {
  logger,
  clearGamesPlaytime,
  WindowManager,
  Lock,
  PowerSaveBlockerManager,
} from "@main/services";
import { installChromiumCloudflareDns } from "./services/cloudflare-dns";
import resources from "@locales";
import { GoRPC } from "./services/go-rpc";
import { db, gamesSublevel, levelKeys } from "./level";
import { GameShop, UserPreferences } from "@types";
import { loadState, loadStateDeferred } from "./main";
import { ASSETS_PATH } from "./constants";

const PROTOCOL = "hydralauncher";

/**
 * Single-instance guard.
 *
 * Game desktop shortcuts launch: gamelaucher.exe hydralauncher://run?...
 * Electron hands those args to the existing process via "second-instance".
 * The losing process must exit quietly for deep-link handoffs — showing an
 * error box here is what users saw when the launcher was already open.
 * A plain second launch (no protocol arg) still shows the "already running" dialog.
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  const isDeepLinkHandoff = process.argv.some((arg) =>
    arg.startsWith(`${PROTOCOL}://`)
  );

  if (!isDeepLinkHandoff) {
    dialog.showErrorBox(
      "Leak Launcher is already running",
      "Ứng dụng đang được mở. Vui lòng kiểm tra khay hệ thống (system tray) hoặc các cửa sổ đang mở."
    );
  }

  // Hard-stop this process so it never bootstraps (splash, LevelDB, RPC…).
  // The primary instance already received "second-instance" with our argv.
  process.exit(0);
}

i18n.init({
  resources,
  lng: "vi",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.lequan.gamelaucher");

  // Chromium/net.fetch + renderer: resolve hosts via Cloudflare DoH.
  installChromiumCloudflareDns();

  // Show a splash window immediately so the user sees the app is starting,
  // instead of waiting for the heavy renderer to load with no feedback.
  WindowManager.openSplashWindow();

  protocol.handle("local", (request) => {
    const requestedPath = decodeURI(request.url.slice("local:".length));
    const assetsRoot = path.resolve(ASSETS_PATH);
    const filePath = path.resolve(requestedPath);

    if (!filePath.startsWith(`${assetsRoot}${path.sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(url.pathToFileURL(filePath).toString());
  });

  protocol.handle("gradient", (request) => {
    const gradientCss = decodeURIComponent(
      request.url.slice("gradient:".length)
    );

    // Parse gradient CSS safely without regex to prevent ReDoS
    let direction = "45deg";
    let color1 = "#4a90e2";
    let color2 = "#7b68ee";

    // Simple string parsing approach - more secure than regex
    if (
      gradientCss.startsWith("linear-gradient(") &&
      gradientCss.endsWith(")")
    ) {
      const content = gradientCss.slice(16, -1); // Remove "linear-gradient(" and ")"
      const parts = content.split(",").map((part) => part.trim());

      if (parts.length >= 3) {
        direction = parts[0];
        color1 = parts[1];
        color2 = parts[2];
      }
    }

    let x1 = "0%",
      y1 = "0%",
      x2 = "100%",
      y2 = "100%";

    if (direction === "to right") {
      y2 = "0%";
    } else if (direction === "to bottom") {
      x2 = "0%";
    } else if (direction === "45deg") {
      y1 = "100%";
      y2 = "0%";
    } else if (direction === "225deg") {
      x1 = "100%";
      x2 = "0%";
    } else if (direction === "315deg") {
      x1 = "100%";
      y1 = "100%";
      x2 = "0%";
      y2 = "0%";
    }
    // Note: "135deg" case removed as it uses all default values

    const svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
        <defs>
          <linearGradient id="grad" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
            <stop offset="0%" style="stop-color:${color1};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${color2};stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
      </svg>
    `;

    return new Response(svgContent, {
      headers: { "Content-Type": "image/svg+xml" },
    });
  });

  // Critical path only (IPC + local auth). Hard cap so splash never sticks.
  try {
    await Promise.race([
      loadState(),
      new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error("loadState critical path timed out")),
          8_000
        );
      }),
    ]);
  } catch (error) {
    logger.error(
      "Critical startup failed or timed out — opening UI anyway",
      error
    );
    // Best-effort: still register events so renderer IPC works.
    try {
      await import("./events");
    } catch (eventsError) {
      logger.error(
        "Failed to register events after startup timeout",
        eventsError
      );
    }
  }

  const language = await db
    .get<string, string>(levelKeys.language, {
      valueEncoding: "utf8",
    })
    .catch(() => "vi");

  if (language) i18n.changeLanguage(language);

  // Check if starting from a "run" deep link - don't show main window in that case
  const deepLinkArg = process.argv.find((arg) =>
    arg.startsWith("hydralauncher://")
  );
  const isRunDeepLink = deepLinkArg?.startsWith("hydralauncher://run");

  // Always leave splash as soon as the main window can open.
  if (!process.argv.includes("--hidden") && !isRunDeepLink) {
    await WindowManager.createMainWindow();
  } else {
    WindowManager.closeSplashWindow();
  }

  WindowManager.createNotificationWindow();
  WindowManager.createSystemTray(language || "en");

  // Downloads / seed / RPC / network after UI is visible.
  void loadStateDeferred();

  if (deepLinkArg) {
    handleDeepLinkPath(deepLinkArg);
  }
});

app.on("browser-window-created", (_, window) => {
  optimizer.watchWindowShortcuts(window);
});

const handleRunGame = async (shop: GameShop, objectId: string) => {
  const gameKey = levelKeys.game(shop, objectId);
  const game = await gamesSublevel.get(gameKey);

  if (!game?.executablePath) {
    logger.error("Game not found or no executable path", { shop, objectId });
    return;
  }

  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    { valueEncoding: "json" }
  );

  // Only open main window if setting is disabled
  if (!userPreferences?.hideToTrayOnGameStart) {
    WindowManager.createMainWindow();
  }

  const { launchGame } = await import("./helpers/launch-game");

  await launchGame({
    shop,
    objectId,
    executablePath: game.executablePath,
    launchOptions: game.launchOptions,
  });
};

const handleDeepLinkPath = (uri?: string) => {
  if (!uri) return;

  try {
    const url = new URL(uri);

    if (url.host === "run") {
      const shop = url.searchParams.get("shop") as GameShop | null;
      const objectId = url.searchParams.get("objectId");

      if (shop && objectId) {
        handleRunGame(shop, objectId);
      }

      return;
    }

    if (url.host === "install-source") {
      WindowManager.redirect(`settings${url.search}`);
      return;
    }
  } catch (error) {
    logger.error("Error handling deep link", uri, error);
  }
};

app.on("second-instance", (_event, commandLine) => {
  const deepLink = commandLine.find((arg) =>
    arg.startsWith("hydralauncher://")
  );

  // Check if this is a "run" deep link - don't show main window in that case
  const isRunDeepLink = deepLink?.startsWith("hydralauncher://run");

  if (!isRunDeepLink) {
    if (WindowManager.mainWindow) {
      if (WindowManager.mainWindow.isMinimized())
        WindowManager.mainWindow.restore();

      WindowManager.mainWindow.focus();
    } else {
      WindowManager.createMainWindow();
    }
  }

  handleDeepLinkPath(deepLink);
});

app.on("open-url", (_event, url) => {
  handleDeepLinkPath(url);
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  WindowManager.mainWindow = null;
});

let canAppBeClosed = false;

app.on("before-quit", (e) => {
  if (canAppBeClosed) return;

  // preventDefault must run synchronously; async work runs after.
  e.preventDefault();

  void (async () => {
    try {
      const { cancelAllGameTransfers } = await import(
        "./events/library/transfer-game-files"
      );
      cancelAllGameTransfers();
    } catch {
      // Transfer module may not be loaded yet during early quit.
    }

    PowerSaveBlockerManager.reset();
    GoRPC.kill();

    try {
      await clearGamesPlaytime();
    } catch (error) {
      logger.error("Failed to flush playtime on quit", error);
    }

    try {
      await Lock.releaseLock();
    } catch (error) {
      logger.error("Failed to release lock on quit", error);
    }

    canAppBeClosed = true;
    app.quit();
  })();
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    WindowManager.createMainWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
