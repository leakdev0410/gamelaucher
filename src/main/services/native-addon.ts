import type { ProcessPayload } from "./download/types";

export type SystemProcessMap = {
  processMap: Record<string, string[]>;
  winePrefixMap: Record<string, string>;
  linuxProcesses: Array<{
    name: string;
    cwd: string;
    exe: string;
    steamCompatDataPath: string | null;
  }>;
};

// The native (Rust) addon was intentionally removed from this fork. These
// stubs keep the call sites compiling; the native-backed capabilities
// (system process / playtime detection and native profile-image processing)
// are disabled — process listing returns empty and images pass through
// unprocessed.
export class NativeAddon {
  static async listProcesses(): Promise<ProcessPayload[]> {
    return [];
  }

  static async getSystemProcessMap(): Promise<SystemProcessMap> {
    return { processMap: {}, winePrefixMap: {}, linuxProcesses: [] };
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
