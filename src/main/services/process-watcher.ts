import { WindowManager } from "./window-manager";
import { createGame, trackGamePlaytime } from "./library-sync";
import type { Game, GameRunning, UserPreferences } from "@types";
import axios from "axios";
import { db, gamesSublevel, levelKeys } from "@main/level";
import { logger, networkLogger } from "./logger";
import { PowerSaveBlockerManager } from "./power-save-blocker";
import path from "node:path";
import { AchievementWatcherManager } from "./achievements/achievement-watcher-manager";
import { INTERVALS } from "@main/constants";
import { appConfig } from "@shared";
import { Wine } from "./wine";
import { NativeAddon } from "./native-addon";
import { CloudSync } from "./cloud-sync";

export const gamesPlaytime = new Map<
  string,
  { lastTick: number; firstTick: number; lastSyncTick: number }
>();

interface ExecutableInfo {
  name: string;
  os: string;
  exe: string;
}

interface GameExecutables {
  [key: string]: ExecutableInfo[];
}

interface LinuxProcessInfo {
  name: string;
  cwd: string;
  exe: string;
  steamCompatDataPath: string | null;
}

const TICKS_TO_UPDATE_API = (3 * 60 * 1000) / INTERVALS.processWatcher; // 3 minutes
let currentTick = 1;

const platform = process.platform;

const logPlaytimeTrace = (
  event: string,
  game: Game,
  payload?: Record<string, unknown>
) => {
  networkLogger.info("[playtime-trace]", event, {
    gameKey: levelKeys.game(game.shop, game.objectId),
    shop: game.shop,
    objectId: game.objectId,
    remoteId: game.remoteId,
    localPlayTimeInMilliseconds: Math.trunc(game.playTimeInMilliseconds ?? 0),
    unsyncedDeltaPlayTimeInMilliseconds:
      game.unsyncedDeltaPlayTimeInMilliseconds ?? 0,
    lastTimePlayed:
      game.lastTimePlayed instanceof Date
        ? game.lastTimePlayed.toISOString()
        : game.lastTimePlayed,
    ...payload,
  });
};

const getGameExecutables = async () => {
  // Hard timeout: must not block main-process import / splash forever.
  const gameExecutables = (
    await axios
      .get(appConfig.externalResourcesUrl + "/game-executables.json", {
        timeout: 8_000,
      })
      .catch(() => {
        return { data: {} };
      })
  ).data as GameExecutables;

  Object.keys(gameExecutables).forEach((key) => {
    gameExecutables[key] = gameExecutables[key]
      .filter((executable) => {
        if (platform === "win32") {
          return executable.os === "win32";
        } else if (platform === "linux") {
          return executable.os === "linux" || executable.os === "win32";
        }

        return false;
      })
      .map((executable) => {
        return {
          name:
            platform === "win32"
              ? executable.name.replace(/\//g, "\\")
              : executable.name,
          os: executable.os,
          exe: executable.name.slice(executable.name.lastIndexOf("/") + 1),
        };
      });
  });

  return gameExecutables;
};

/** Populated asynchronously — never block main-process import on network. */
export let gameExecutables: GameExecutables = {};

void getGameExecutables()
  .then((data) => {
    gameExecutables = data;
  })
  .catch((error) => {
    logger.error("[process-watcher] Failed to load game-executables.json", error);
  });

const findGamePathByProcess = async (
  processMap: Map<string, Set<string>>,
  winePrefixMap: Map<string, string>,
  gameId: string
) => {
  const executables = gameExecutables[gameId];

  for (const executable of executables) {
    const executablewithoutExtension = executable.exe.replace(/\.exe$/i, "");

    const pathSet =
      processMap.get(executable.exe) ??
      processMap.get(executablewithoutExtension);

    if (pathSet) {
      for (const path of pathSet) {
        if (
          path.toLowerCase().endsWith(executable.name) ||
          path.toLowerCase().endsWith(executablewithoutExtension)
        ) {
          const gameKey = levelKeys.game("steam", gameId);
          const game = await gamesSublevel.get(gameKey);

          if (game) {
            const updatedGame: Game = {
              ...game,
              executablePath: path,
            };

            if (process.platform === "linux" && winePrefixMap.has(path)) {
              updatedGame.winePrefixPath = winePrefixMap.get(path)!;
            }

            await gamesSublevel.put(gameKey, updatedGame);
            logger.info("Set game path", gameKey, path);
          }
        }
      }
    }
  }
};

const getSystemProcessMap = async () => {
  const {
    processMap: rawMap,
    winePrefixMap: rawWineMap,
    linuxProcesses,
  } = await NativeAddon.getSystemProcessMap();

  const processMap = new Map<string, Set<string>>(
    Object.entries(rawMap).map(([k, v]) => [k, new Set(v)])
  );

  const winePrefixMap = new Map<string, string>(Object.entries(rawWineMap));

  return { processMap, winePrefixMap, linuxProcesses };
};

const hasLinuxCompatibilityProcessMatch = (
  game: Game,
  executablePath: string,
  linuxProcesses: LinuxProcessInfo[]
) => {
  if (path.extname(executablePath).toLowerCase() !== ".exe") {
    return false;
  }

  const executableName = path.basename(executablePath).toLowerCase();
  const executableNameWithoutExtension = executableName.replace(/\.exe$/i, "");
  const executableDirectory = path.dirname(executablePath).toLowerCase();
  const expectedWinePrefix = Wine.getEffectivePrefixPath(
    game.winePrefixPath,
    game.objectId
  )?.toLowerCase();

  return linuxProcesses.some((process) => {
    if (process.cwd !== executableDirectory) {
      return false;
    }

    if (
      expectedWinePrefix &&
      process.steamCompatDataPath &&
      process.steamCompatDataPath !== expectedWinePrefix
    ) {
      return false;
    }

    if (
      process.name === executableName ||
      process.name === executableNameWithoutExtension
    ) {
      return true;
    }

    const processRunsUnderWine = process.exe.includes("wine");

    return processRunsUnderWine && process.name.length > 0;
  });
};

export const watchProcesses = async () => {
  const games = await gamesSublevel
    .values()
    .all()
    .then((results) => {
      return results.filter((game) => game.isDeleted === false);
    });

  if (!games.length) return;

  const { processMap, winePrefixMap, linuxProcesses } =
    await getSystemProcessMap();

  for (const game of games) {
    const gameKey = levelKeys.game(game.shop, game.objectId);
    const executablePath = game.executablePath;
    if (!executablePath) {
      if (gameExecutables[game.objectId]) {
        await findGamePathByProcess(processMap, winePrefixMap, game.objectId);
      }

      continue;
    }

    const executable = executablePath
      .slice(executablePath.lastIndexOf(platform === "win32" ? "\\" : "/") + 1)
      .toLowerCase();

    let hasProcess = processMap.get(executable)?.has(executablePath) ?? false;

    if (!hasProcess && platform === "linux") {
      hasProcess = hasLinuxCompatibilityProcessMatch(
        game,
        executablePath,
        linuxProcesses
      );
    }

    if (hasProcess) {
      if (gamesPlaytime.has(gameKey)) {
        await onTickGame(game);
      } else {
        onOpenGame(game);
      }
    } else if (gamesPlaytime.has(gameKey)) {
      await onCloseGame(game);
    }
  }

  currentTick++;

  if (WindowManager.mainWindow) {
    const gamesRunning = Array.from(gamesPlaytime.entries()).map((entry) => {
      return {
        id: entry[0],
        sessionDurationInMillis: performance.now() - entry[1].firstTick,
      } as Pick<GameRunning, "id" | "sessionDurationInMillis">;
    });

    WindowManager.mainWindow.webContents.send("on-games-running", gamesRunning);
  }
};

function onOpenGame(game: Game) {
  const now = performance.now();
  const gameKey = levelKeys.game(game.shop, game.objectId);

  gamesPlaytime.set(gameKey, {
    lastTick: now,
    firstTick: now,
    lastSyncTick: now,
  });

  logPlaytimeTrace("session-open", game, {
    performanceNow: now,
  });

  // On Linux, keep the launcher visible briefly and let it auto-close itself.
  if (process.platform !== "linux") {
    WindowManager.closeGameLauncherWindow();
  }

  // Hide app to tray on game startup if enabled
  db.get<string, UserPreferences | null>(levelKeys.userPreferences, {
    valueEncoding: "json",
  })
    .then((userPreferences) => {
      if (userPreferences?.hideToTrayOnGameStart) {
        WindowManager.mainWindow?.hide();
      }
    })
    .catch(() => {});

  if (game.shop === "custom") return;

  AchievementWatcherManager.firstSyncWithRemoteIfNeeded(
    game.shop,
    game.objectId
  );

  if (game.remoteId) {
    const deltaToSync = game.unsyncedDeltaPlayTimeInMilliseconds ?? 0;
    const syncTimestamp = new Date();

    logPlaytimeTrace("open-sync-track-request", game, {
      deltaToSync,
      syncTimestamp: syncTimestamp.toISOString(),
    });

    trackGamePlaytime(game, deltaToSync, syncTimestamp)
      .then(async () => {
        logPlaytimeTrace("open-sync-track-success", game, {
          deltaToSync,
        });

        const latest = (await gamesSublevel.get(gameKey).catch(() => null)) ?? game;
        await gamesSublevel.put(gameKey, {
          ...latest,
          unsyncedDeltaPlayTimeInMilliseconds: 0,
        });
      })
      .catch((error) => {
        logPlaytimeTrace("open-sync-track-failed", game, {
          deltaToSync,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } else {
    const payload = { ...game, lastTimePlayed: new Date() };

    logPlaytimeTrace("open-sync-create-request", payload, {
      syncTimestamp:
        payload.lastTimePlayed instanceof Date
          ? payload.lastTimePlayed.toISOString()
          : payload.lastTimePlayed,
    });

    createGame(payload)
      .then(() => {
        logPlaytimeTrace("open-sync-create-success", payload);
      })
      .catch((error) => {
        logPlaytimeTrace("open-sync-create-failed", payload, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

async function onTickGame(game: Game) {
  const now = performance.now();
  const gameKey = levelKeys.game(game.shop, game.objectId);
  const gamePlaytime = gamesPlaytime.get(gameKey)!;

  const delta = now - gamePlaytime.lastTick;
  const latest = (await gamesSublevel.get(gameKey).catch(() => null)) ?? game;

  const updatedGame: Game = {
    ...latest,
    playTimeInMilliseconds: (latest.playTimeInMilliseconds ?? 0) + delta,
    lastTimePlayed: new Date(),
  };

  await gamesSublevel.put(gameKey, updatedGame);

  gamesPlaytime.set(gameKey, {
    ...gamePlaytime,
    lastTick: now,
  });

  if (currentTick % TICKS_TO_UPDATE_API === 0 && updatedGame.shop !== "custom") {
    const deltaToSync =
      now -
      gamePlaytime.lastSyncTick +
      (latest.unsyncedDeltaPlayTimeInMilliseconds ?? 0);

    logPlaytimeTrace("periodic-sync-request", updatedGame, {
      method: updatedGame.remoteId ? "track" : "create",
      deltaToSync,
      performanceNow: now,
      lastSyncTick: gamePlaytime.lastSyncTick,
      lastTick: gamePlaytime.lastTick,
    });

    const gamePromise = updatedGame.remoteId
      ? trackGamePlaytime(
          updatedGame,
          deltaToSync,
          updatedGame.lastTimePlayed!
        )
      : createGame(updatedGame);

    gamePromise
      .then(async () => {
        logPlaytimeTrace("periodic-sync-success", updatedGame, {
          method: updatedGame.remoteId ? "track" : "create",
          deltaToSync,
        });

        const freshest =
          (await gamesSublevel.get(gameKey).catch(() => null)) ?? updatedGame;
        await gamesSublevel.put(gameKey, {
          ...freshest,
          unsyncedDeltaPlayTimeInMilliseconds: 0,
        });
      })
      .catch(async (error) => {
        logPlaytimeTrace("periodic-sync-failed", updatedGame, {
          method: updatedGame.remoteId ? "track" : "create",
          deltaToSync,
          error: error instanceof Error ? error.message : String(error),
        });

        const freshest =
          (await gamesSublevel.get(gameKey).catch(() => null)) ?? updatedGame;
        await gamesSublevel.put(gameKey, {
          ...freshest,
          unsyncedDeltaPlayTimeInMilliseconds: deltaToSync,
        });
      })
      .finally(() => {
        gamesPlaytime.set(gameKey, {
          ...gamePlaytime,
          lastTick: now,
          lastSyncTick: now,
        });
      });
  }
}

const onCloseGame = async (game: Game) => {
  const gameKey = levelKeys.game(game.shop, game.objectId);
  const now = performance.now();
  const gamePlaytime = gamesPlaytime.get(gameKey)!;
  gamesPlaytime.delete(gameKey);
  PowerSaveBlockerManager.markGameClosed(gameKey);

  const delta = now - gamePlaytime.lastTick;

  logPlaytimeTrace("session-close", game, {
    performanceNow: now,
    delta,
    firstTick: gamePlaytime.firstTick,
    lastTick: gamePlaytime.lastTick,
    lastSyncTick: gamePlaytime.lastSyncTick,
  });

  const latest = (await gamesSublevel.get(gameKey).catch(() => null)) ?? game;

  const updatedGame: Game = {
    ...latest,
    playTimeInMilliseconds: (latest.playTimeInMilliseconds ?? 0) + delta,
    lastTimePlayed: new Date(),
  };

  await gamesSublevel.put(gameKey, updatedGame);

  if (updatedGame.automaticCloudSync) {
    void CloudSync.uploadSaveGame(
      updatedGame.objectId,
      updatedGame.shop,
      null
    ).catch((error) => {
      logger.error(
        `[process-watcher] automaticCloudSync failed for ${gameKey}`,
        error
      );
    });
  }

  if (updatedGame.shop === "custom") return;

  if (updatedGame.remoteId) {
    const deltaToSync =
      now -
      gamePlaytime.lastSyncTick +
      (latest.unsyncedDeltaPlayTimeInMilliseconds ?? 0);

    logPlaytimeTrace("close-sync-track-request", updatedGame, {
      deltaToSync,
      syncTimestamp:
        updatedGame.lastTimePlayed instanceof Date
          ? updatedGame.lastTimePlayed.toISOString()
          : updatedGame.lastTimePlayed,
    });

    return trackGamePlaytime(
      updatedGame,
      deltaToSync,
      updatedGame.lastTimePlayed!
    )
      .then(async () => {
        logPlaytimeTrace("close-sync-track-success", updatedGame, {
          deltaToSync,
        });

        const freshest =
          (await gamesSublevel.get(gameKey).catch(() => null)) ?? updatedGame;
        return gamesSublevel.put(gameKey, {
          ...freshest,
          unsyncedDeltaPlayTimeInMilliseconds: 0,
        });
      })
      .catch(async (error) => {
        logPlaytimeTrace("close-sync-track-failed", updatedGame, {
          deltaToSync,
          error: error instanceof Error ? error.message : String(error),
        });

        const freshest =
          (await gamesSublevel.get(gameKey).catch(() => null)) ?? updatedGame;
        return gamesSublevel.put(gameKey, {
          ...freshest,
          unsyncedDeltaPlayTimeInMilliseconds: deltaToSync,
        });
      });
  } else {
    logPlaytimeTrace("close-sync-create-request", updatedGame, {
      syncTimestamp:
        updatedGame.lastTimePlayed instanceof Date
          ? updatedGame.lastTimePlayed.toISOString()
          : updatedGame.lastTimePlayed,
    });

    return createGame(updatedGame)
      .then(() => {
        logPlaytimeTrace("close-sync-create-success", updatedGame);
      })
      .catch((error) => {
        logPlaytimeTrace("close-sync-create-failed", updatedGame, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
};

export const clearGamesPlaytime = async () => {
  for (const game of gamesPlaytime.keys()) {
    const gameData = await gamesSublevel.get(game);

    if (gameData) {
      await onCloseGame(gameData);
    }
  }

  gamesPlaytime.clear();
};
