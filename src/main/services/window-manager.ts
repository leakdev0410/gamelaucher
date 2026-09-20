import { is } from "@electron-toolkit/utils";
import { isStaging } from "@main/constants";
import { db, gamesSublevel, levelKeys } from "@main/level";
import icon from "@resources/icon.png?asset";
import trayIcon from "@resources/tray-icon.png?asset";
import { AuthPage, appConfig } from "@shared";
import type {
  AchievementCustomNotificationPosition,
  ScreenState,
  UserPreferences,
} from "@types";
import {
  BrowserWindow,
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
  Tray,
  app,
  nativeImage,
  screen,
  shell,
} from "electron";
import { t } from "i18next";
import { orderBy, slice } from "lodash-es";
import fs from "node:fs";
import path from "node:path";
import UserAgent from "user-agents";
import { ApiClient } from "./api-client";
import { logger } from "./logger";

export class WindowManager {
  public static mainWindow: Electron.BrowserWindow | null = null;
  public static notificationWindow: Electron.BrowserWindow | null = null;
  public static gameLauncherWindow: Electron.BrowserWindow | null = null;
  private static splashWindow: Electron.BrowserWindow | null = null;

  private static readonly editorWindows: Map<string, BrowserWindow> = new Map();

  private static initialConfigInitializationMainWindow: Electron.BrowserWindowConstructorOptions =
    {
      width: 1200,
      height: 860,
      minWidth: 1024,
      minHeight: 860,
      backgroundColor: "#f5f4ee",
      titleBarStyle: process.platform === "linux" ? "default" : "hidden",
      icon,
      trafficLightPosition: { x: 16, y: 16 },
      titleBarOverlay: {
        // Match Claude Cream chrome — fully opaque overlay avoids black
        // corners on some Windows builds.
        symbolColor: "#30302a",
        color: "#ffffff",
        height: 34,
      },
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.mjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
      show: false,
    };

  private static async loadWindowURL(window: BrowserWindow, hash: string = "") {
    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
      window.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}#/${hash}`);
    } else {
      window.loadFile(path.join(__dirname, "../renderer/index.html"), {
        hash,
      });
    }
  }

  private static async loadMainWindowURL(hash: string = "") {
    if (this.mainWindow) {
      await this.loadWindowURL(this.mainWindow, hash);
    }
  }

  public static sendToAppWindows(channel: string, ...args: unknown[]) {
    const windows = [this.mainWindow];

    for (const window of windows) {
      if (!window || window.isDestroyed()) continue;
      window.webContents.send(channel, ...args);
    }
  }

  public static sendDownloadsUpdated() {
    this.sendToAppWindows("on-downloads-updated");
  }

  private static async saveScreenConfig(configScreenWhenClosed: ScreenState) {
    await db.put(levelKeys.screenState, configScreenWhenClosed, {
      valueEncoding: "json",
    });
  }

  private static async loadScreenConfig() {
    const data = await db.get<string, ScreenState | undefined>(
      levelKeys.screenState,
      {
        valueEncoding: "json",
      }
    );
    return data ?? { isMaximized: false, height: 860, width: 1200 };
  }

  private static updateInitialConfig(
    newConfig: Partial<Electron.BrowserWindowConstructorOptions>
  ) {
    this.initialConfigInitializationMainWindow = {
      ...this.initialConfigInitializationMainWindow,
      ...newConfig,
    };
  }

  public static openSplashWindow() {
    if (this.splashWindow) return;

    let logoBase64 = "";
    try {
      logoBase64 = fs.readFileSync(icon).toString("base64");
    } catch {
      logoBase64 = "";
    }

    this.splashWindow = new BrowserWindow({
      width: 380,
      height: 440,
      frame: false,
      resizable: false,
      center: true,
      backgroundColor: "#f5f4ee",
      title: "Game Launcher",
      icon,
      webPreferences: { sandbox: true },
    });
    this.splashWindow.removeMenu();

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;}
      body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;
        background:#f5f4ee;font-family:'Segoe UI',Roboto,sans-serif;color:#6b6558;
        -webkit-app-region:drag;user-select:none;overflow:hidden;}
      .logo{width:96px;height:96px;border-radius:22px;box-shadow:0 4px 24px rgba(48,45,38,.16);}
      .name{font-size:21px;font-weight:700;color:#30302a;letter-spacing:.3px;}
      .author{font-size:12px;color:#948c7c;margin-top:-14px;}
      .spinner{width:26px;height:26px;border:3px solid rgba(48,45,38,.12);
        border-top-color:#d97757;border-radius:50%;animation:spin .8s linear infinite;}
      .status{font-size:13px;color:#948c7c;}
      @keyframes spin{to{transform:rotate(360deg);}}
    </style></head><body>
      ${logoBase64 ? `<img class="logo" src="data:image/png;base64,${logoBase64}"/>` : ""}
      <div class="name">Game Launcher</div>
      <div class="author">by Lê Quân</div>
      <div class="spinner"></div>
      <div class="status">Đang khởi động…</div>
    </body></html>`;

    this.splashWindow.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html)
    );

    this.splashWindow.on("closed", () => {
      this.splashWindow = null;
    });
  }

  public static closeSplashWindow() {
    if (this.splashWindow && !this.splashWindow.isDestroyed()) {
      this.splashWindow.close();
    }
    this.splashWindow = null;
  }

  public static async createMainWindow() {
    if (this.mainWindow) return;

    const userPreferences = await db
      .get<string, UserPreferences | null>(levelKeys.userPreferences, {
        valueEncoding: "json",
      })
      .catch(() => null);

    const { isMaximized = false, ...configWithoutMaximized } =
      await this.loadScreenConfig();

    this.updateInitialConfig(configWithoutMaximized);

    this.mainWindow = new BrowserWindow(
      this.initialConfigInitializationMainWindow
    );

    if (isMaximized) {
      this.mainWindow.maximize();
    }

    this.mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      (details, callback) => {
        if (
          details.webContentsId !== this.mainWindow?.webContents.id ||
          details.url.includes("chatwoot")
        ) {
          return callback(details);
        }

        const userAgent = new UserAgent();

        callback({
          requestHeaders: {
            ...details.requestHeaders,
            "user-agent": userAgent.toString(),
          },
        });
      }
    );

    this.mainWindow.webContents.session.webRequest.onHeadersReceived(
      (details, callback) => {
        if (details.webContentsId !== this.mainWindow?.webContents.id) {
          return callback(details);
        }

        // A local renderer needs no permissive CORS policy.  CSP limits the
        // blast radius if a future rendering bug slips through.
        if (details.url.startsWith("file://")) {
          return callback({
            responseHeaders: {
              ...details.responseHeaders,
              "content-security-policy": [
                "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: local: gradient:; media-src 'self' data: https:; connect-src 'self' https: wss:; font-src 'self' data:;",
              ],
            },
          });
        }

        return callback(details);
      }
    );

    const initialHash = userPreferences?.launchToLibraryPage ? "library" : "";

    void this.loadMainWindowURL(initialHash);
    this.mainWindow.removeMenu();
    this.mainWindow.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });

    let handedOffFromSplash = false;
    const handOffFromSplash = () => {
      if (handedOffFromSplash) return;
      handedOffFromSplash = true;
      if (!app.isPackaged || isStaging)
        WindowManager.mainWindow?.webContents.openDevTools();
      WindowManager.closeSplashWindow();
      WindowManager.mainWindow?.show();
    };

    this.mainWindow.on("ready-to-show", () => {
      handOffFromSplash();
    });

    // Hard fallback: never leave the user stuck on "Đang khởi động…"
    // if ready-to-show is delayed (slow disk / renderer compile / DNS).
    setTimeout(() => {
      handOffFromSplash();
    }, 4_000);

    this.mainWindow.on("close", async () => {
      const mainWindow = this.mainWindow;
      this.mainWindow = null;

      const userPreferences = await db.get<string, UserPreferences>(
        levelKeys.userPreferences,
        {
          valueEncoding: "json",
        }
      );

      if (mainWindow) {
        mainWindow.setProgressBar(-1);

        const lastBounds = mainWindow.getBounds();
        const isMaximized = mainWindow.isMaximized() ?? false;
        const screenConfig = isMaximized
          ? {
              x: undefined,
              y: undefined,
              height: this.initialConfigInitializationMainWindow.height ?? 860,
              width: this.initialConfigInitializationMainWindow.width ?? 1200,
              isMaximized: true,
            }
          : { ...lastBounds, isMaximized };

        await this.saveScreenConfig(screenConfig);
      }

      if (userPreferences?.preferQuitInsteadOfHiding) {
        app.quit();
      }
    });

    this.mainWindow.webContents.setWindowOpenHandler((handler) => {
      try {
        const target = new URL(handler.url);
        if (target.protocol === "https:") {
          void shell.openExternal(target.toString());
        }
      } catch {
        // Invalid and non-web URLs must never be delegated to the OS.
      }
      return { action: "deny" };
    });
  }

  public static openAuthWindow(page: AuthPage, searchParams: URLSearchParams) {
    if (this.mainWindow) {
      const authWindow = new BrowserWindow({
        width: 600,
        height: 640,
        backgroundColor: "#f5f4ee",
        parent: this.mainWindow,
        modal: true,
        show: false,
        maximizable: false,
        resizable: false,
        minimizable: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
        },
      });

      authWindow.removeMenu();

      if (!app.isPackaged) authWindow.webContents.openDevTools();

      authWindow.loadURL(
        `${appConfig.authUrl}${page}?${searchParams.toString()}`
      );

      authWindow.once("ready-to-show", () => {
        authWindow.show();
      });

      authWindow.webContents.on("will-navigate", (event, url) => {
        if (url.startsWith("hydralauncher://auth")) {
          event.preventDefault();
          authWindow.close();

          void ApiClient.handleExternalAuth(url).catch((error) => {
            logger.error("Rejected authentication callback", error);
          });
          return;
        }

        if (url.startsWith("hydralauncher://update-account")) {
          event.preventDefault();
          authWindow.close();

          WindowManager.mainWindow?.webContents.send("on-account-updated");
        }
      });
    }
  }

  private static readonly NOTIFICATION_WINDOW_WIDTH = 360;
  private static readonly NOTIFICATION_WINDOW_HEIGHT = 140;

  private static async getNotificationWindowPosition(
    position: AchievementCustomNotificationPosition | undefined
  ) {
    const display = screen.getPrimaryDisplay();
    const {
      x: displayX,
      y: displayY,
      width: displayWidth,
      height: displayHeight,
    } = display.bounds;

    if (position === "bottom-left") {
      return {
        x: displayX,
        y: displayY + displayHeight - this.NOTIFICATION_WINDOW_HEIGHT,
      };
    }

    if (position === "bottom-center") {
      return {
        x: displayX + (displayWidth - this.NOTIFICATION_WINDOW_WIDTH) / 2,
        y: displayY + displayHeight - this.NOTIFICATION_WINDOW_HEIGHT,
      };
    }

    if (position === "bottom-right") {
      return {
        x: displayX + displayWidth - this.NOTIFICATION_WINDOW_WIDTH,
        y: displayY + displayHeight - this.NOTIFICATION_WINDOW_HEIGHT,
      };
    }

    if (position === "top-left") {
      return {
        x: displayX,
        y: displayY,
      };
    }

    if (position === "top-center") {
      return {
        x: displayX + (displayWidth - this.NOTIFICATION_WINDOW_WIDTH) / 2,
        y: displayY,
      };
    }

    if (position === "top-right") {
      return {
        x: displayX + displayWidth - this.NOTIFICATION_WINDOW_WIDTH,
        y: displayY,
      };
    }

    return {
      x: displayX,
      y: displayY,
    };
  }

  public static async createNotificationWindow() {
    if (this.notificationWindow) return;

    if (process.platform === "darwin") {
      return;
    }

    const userPreferences = await db.get<string, UserPreferences | undefined>(
      levelKeys.userPreferences,
      {
        valueEncoding: "json",
      }
    );

    if (
      userPreferences?.achievementNotificationsEnabled === false ||
      userPreferences?.achievementCustomNotificationsEnabled === false
    ) {
      return;
    }

    const { x, y } = await this.getNotificationWindowPosition(
      userPreferences?.achievementCustomNotificationPosition
    );

    this.notificationWindow = new BrowserWindow({
      transparent: true,
      maximizable: false,
      autoHideMenuBar: true,
      minimizable: false,
      // Fully transparent host; any solid paint shows as a black corner panel.
      backgroundColor: "#00000000",
      focusable: false,
      skipTaskbar: true,
      frame: false,
      hasShadow: false,
      thickFrame: false,
      resizable: false,
      width: this.NOTIFICATION_WINDOW_WIDTH,
      height: this.NOTIFICATION_WINDOW_HEIGHT,
      x,
      y,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.mjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    this.notificationWindow.setIgnoreMouseEvents(true);
    this.notificationWindow.setAlwaysOnTop(true, "screen-saver", 1);
    this.notificationWindow.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });

    this.notificationWindow.once("ready-to-show", () => {
      // Only surface the window after the transparent page is ready to avoid
      // a black flash/rect on Windows DWM.
      if (this.notificationWindow && !this.notificationWindow.isDestroyed()) {
        this.notificationWindow.showInactive();
      }
    });

    this.loadWindowURL(this.notificationWindow, "achievement-notification");
    // Never open DevTools here — it paints an opaque panel at the screen corner.
  }

  public static async closeNotificationWindow() {
    if (this.notificationWindow) {
      this.notificationWindow.close();
      this.notificationWindow = null;
    }
  }

  public static openEditorWindow(themeId: string) {
    if (this.mainWindow) {
      const existingWindow = this.editorWindows.get(themeId);
      if (existingWindow) {
        if (existingWindow.isMinimized()) {
          existingWindow.restore();
        }
        existingWindow.focus();
        return;
      }

      const editorWindow = new BrowserWindow({
        width: 720,
        height: 720,
        minWidth: 600,
        minHeight: 540,
        backgroundColor: "#f5f4ee",
        titleBarStyle: process.platform === "linux" ? "default" : "hidden",
        icon,
        trafficLightPosition: { x: 16, y: 16 },
        titleBarOverlay: {
          symbolColor: "#30302a",
          color: "#ffffff",
          height: 34,
        },
        webPreferences: {
          preload: path.join(__dirname, "../preload/index.mjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
        },
        show: false,
      });

      this.editorWindows.set(themeId, editorWindow);

      editorWindow.removeMenu();
      editorWindow.webContents.on("will-navigate", (event) => {
        event.preventDefault();
      });

      this.loadWindowURL(editorWindow, `theme-editor?themeId=${themeId}`);

      editorWindow.once("ready-to-show", () => {
        editorWindow.show();
        if (!app.isPackaged || isStaging) {
          editorWindow.webContents.openDevTools();
        }
      });

      editorWindow.webContents.on("before-input-event", (_event, input) => {
        if (input.key === "F12") {
          this.mainWindow?.webContents.toggleDevTools();
        }
      });

      editorWindow.on("close", () => {
        this.mainWindow?.webContents.closeDevTools();
        this.editorWindows.delete(themeId);
      });
    }
  }

  public static closeEditorWindow(themeId?: string) {
    if (themeId) {
      const editorWindow = this.editorWindows.get(themeId);
      if (editorWindow) {
        editorWindow.close();
      }
    } else {
      this.editorWindows.forEach((editorWindow) => {
        editorWindow.close();
      });
    }
  }

  private static readonly GAME_LAUNCHER_WINDOW_WIDTH = 550;
  private static readonly GAME_LAUNCHER_WINDOW_HEIGHT = 320;

  public static async createGameLauncherWindow(shop: string, objectId: string) {
    if (this.gameLauncherWindow) {
      this.gameLauncherWindow.close();
      this.gameLauncherWindow = null;
    }

    const display = screen.getPrimaryDisplay();
    const { width: displayWidth, height: displayHeight } = display.bounds;

    const x = Math.round((displayWidth - this.GAME_LAUNCHER_WINDOW_WIDTH) / 2);
    const y = Math.round(
      (displayHeight - this.GAME_LAUNCHER_WINDOW_HEIGHT) / 2
    );

    this.gameLauncherWindow = new BrowserWindow({
      width: this.GAME_LAUNCHER_WINDOW_WIDTH,
      height: this.GAME_LAUNCHER_WINDOW_HEIGHT,
      x,
      y,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      frame: false,
      backgroundColor: "#f5f4ee",
      icon,
      skipTaskbar: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.mjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
      show: false,
    });

    this.gameLauncherWindow.removeMenu();
    this.gameLauncherWindow.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });

    this.loadWindowURL(
      this.gameLauncherWindow,
      `game-launcher?shop=${shop}&objectId=${objectId}`
    );

    this.gameLauncherWindow.on("closed", () => {
      this.gameLauncherWindow = null;
    });

    if (!app.isPackaged || isStaging) {
      this.gameLauncherWindow.webContents.openDevTools();
    }
  }

  public static showGameLauncherWindow() {
    if (this.gameLauncherWindow && !this.gameLauncherWindow.isDestroyed()) {
      this.gameLauncherWindow.show();
    }
  }

  public static closeGameLauncherWindow() {
    if (this.gameLauncherWindow) {
      this.gameLauncherWindow.close();
      this.gameLauncherWindow = null;
    }
  }

  public static openMainWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.focus();
    } else {
      this.createMainWindow();
    }
  }

  public static redirect(hash: string) {
    if (!this.mainWindow) this.createMainWindow();
    this.loadMainWindowURL(hash);

    if (this.mainWindow?.isMinimized()) this.mainWindow.restore();
    this.mainWindow?.focus();
  }

  public static async createSystemTray(language: string) {
    let tray: Tray;

    if (process.platform === "darwin") {
      const macIcon = nativeImage
        .createFromPath(trayIcon)
        .resize({ width: 24, height: 24 });
      tray = new Tray(macIcon);
    } else {
      tray = new Tray(trayIcon);
    }

    const updateSystemTray = async () => {
      const games = await gamesSublevel
        .values()
        .all()
        .then((games) => {
          const filteredGames = games.filter(
            (game) =>
              !game.isDeleted && game.executablePath && game.lastTimePlayed
          );

          const sortedGames = orderBy(filteredGames, "lastTimePlayed", "desc");

          return slice(sortedGames, 0, 6);
        });

      const recentlyPlayedGames: Array<MenuItemConstructorOptions | MenuItem> =
        games.map(
          ({ title, shop, objectId, executablePath, launchOptions }) => ({
            label: title.length > 18 ? `${title.slice(0, 18)}…` : title,
            type: "normal",
            click: async () => {
              if (!executablePath) return;

              const { launchGame } = await import("@main/helpers/launch-game");
              await launchGame({
                shop,
                objectId,
                executablePath,
                launchOptions,
              }).catch((error) => {
                logger.error("Failed to launch game from tray", error);
              });
            },
          })
        );

      const contextMenu = Menu.buildFromTemplate([
        {
          label: t("open", {
            ns: "system_tray",
            lng: language,
          }),
          type: "normal",
          click: () => {
            if (this.mainWindow) {
              this.mainWindow.show();
            } else {
              this.createMainWindow();
            }
          },
        },
        {
          type: "separator",
        },
        ...recentlyPlayedGames,
        {
          type: "separator",
        },
        {
          label: t("quit", {
            ns: "system_tray",
            lng: language,
          }),
          type: "normal",
          click: () => app.quit(),
        },
      ]);

      if (process.platform === "linux") {
        tray.setContextMenu(contextMenu);
      }

      return contextMenu;
    };

    const showContextMenu = async () => {
      const contextMenu = await updateSystemTray();
      tray.popUpContextMenu(contextMenu);
    };

    tray.setToolTip("Game Launcher");

    if (process.platform === "win32") {
      await updateSystemTray();

      tray.addListener("double-click", () => {
        if (this.mainWindow) {
          this.mainWindow.show();
        } else {
          this.createMainWindow();
        }
      });

      tray.addListener("right-click", showContextMenu);
    } else if (process.platform === "linux") {
      await updateSystemTray();

      tray.addListener("click", () => {
        if (this.mainWindow) {
          this.mainWindow.show();
        } else {
          this.createMainWindow();
        }
      });

      tray.addListener("right-click", showContextMenu);
    } else {
      tray.addListener("click", showContextMenu);
      tray.addListener("right-click", showContextMenu);
    }
  }
}
