import { db } from "@main/level";
import { levelKeys } from "@main/level/sublevels/keys";

const sublevelCache = new Map<
  string,
  ReturnType<typeof db.sublevel<string, unknown>>
>();

/** Sublevels the renderer may access via the generic leveldb IPC bridge. */
export const ALLOWED_LEVELDB_SUBLEVELS = new Set<string>([
  levelKeys.games,
  levelKeys.downloads,
  levelKeys.downloadLayoutState,
  levelKeys.gameShopAssets,
  levelKeys.gameShopCache,
  levelKeys.gameStatsCache,
  levelKeys.gameAchievements,
  levelKeys.downloadSources,
  levelKeys.themes,
  levelKeys.localNotifications,
]);

/** Root keys that must not be written/deleted via generic IPC. */
export const PROTECTED_ROOT_KEYS = new Set<string>([
  levelKeys.auth,
  levelKeys.user,
  levelKeys.rpcPassword,
]);

/**
 * Gets a sublevel by name from the allowlist only (no auto-create of unknown names).
 */
export const getSublevelByName = (
  sublevelName: string
): ReturnType<typeof db.sublevel<string, unknown>> => {
  if (!ALLOWED_LEVELDB_SUBLEVELS.has(sublevelName)) {
    throw new Error(`LevelDB sublevel not allowed: ${sublevelName}`);
  }

  if (sublevelCache.has(sublevelName)) {
    return sublevelCache.get(sublevelName)!;
  }

  const sublevel = db.sublevel<string, unknown>(sublevelName, {
    valueEncoding: "json",
  });
  sublevelCache.set(sublevelName, sublevel);
  return sublevel;
};

export const assertRootKeyWritable = (key: string) => {
  if (PROTECTED_ROOT_KEYS.has(key)) {
    throw new Error(`LevelDB root key is protected: ${key}`);
  }
};
