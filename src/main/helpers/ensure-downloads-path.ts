import fs from "node:fs";
import { defaultDownloadsPath } from "@main/constants";
import { logger } from "@main/services/logger";

/**
 * Ensure a downloads directory exists (mkdir recursive).
 * Used for the portable default `<exe>/game` folder and any path the user picks.
 */
export function ensureDownloadsPathExists(targetPath: string): boolean {
  if (!targetPath?.trim()) return false;

  try {
    fs.mkdirSync(targetPath, { recursive: true });
    return true;
  } catch (error) {
    logger.error(
      `[ensureDownloadsPathExists] Failed to create "${targetPath}"`,
      error
    );
    return false;
  }
}

/** Create the portable default game folder next to the executable if missing. */
export function ensureDefaultGameFolder(): string {
  ensureDownloadsPathExists(defaultDownloadsPath);
  return defaultDownloadsPath;
}
