import type { ProcessPayload } from "./download/types";
import {
  buildSystemProcessMap,
  listSystemProcesses,
  type SystemProcessMap,
} from "./process-list";

export type { SystemProcessMap };

/**
 * Process / image helpers formerly provided by the removed Rust native addon.
 * Process listing is implemented in pure Node (see process-list.ts).
 * Profile image processing remains a pass-through (no native convert).
 */
export class NativeAddon {
  static async listProcesses(): Promise<ProcessPayload[]> {
    return listSystemProcesses();
  }

  static async getSystemProcessMap(): Promise<SystemProcessMap> {
    return buildSystemProcessMap();
  }

  static processProfileImage(
    imagePath: string,
    _targetExtension = "webp"
  ): { imagePath: string; mimeType: string } {
    const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
    const mimeType =
      ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/jpeg";

    return { imagePath, mimeType };
  }
}
