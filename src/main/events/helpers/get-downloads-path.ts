import { defaultDownloadsPath } from "@main/constants";
import { db, levelKeys } from "@main/level";
import type { UserPreferences } from "@types";
import { ensureDownloadsPathExists } from "@main/helpers/ensure-downloads-path";

export const getDownloadsPath = async () => {
  const userPreferences = await db.get<string, UserPreferences | null>(
    levelKeys.userPreferences,
    {
      valueEncoding: "json",
    }
  );

  const downloadsPath =
    userPreferences?.downloadsPath?.trim() || defaultDownloadsPath;

  // Always create the path so first download / settings never fails with
  // "cannot write" just because the portable `game` folder was missing.
  ensureDownloadsPathExists(downloadsPath);

  return downloadsPath;
};
