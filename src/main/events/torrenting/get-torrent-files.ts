import { registerEvent } from "../register-event";
import { GoRPC, GoRpcError } from "@main/services/go-rpc";
import type { TorrentFilesResponse } from "@types";
import { DownloadError } from "@shared";

const mapTorrentFilesError = (error: unknown) => {
  const codeFromGoRpc =
    error instanceof GoRpcError
      ? error.code
      : typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { code: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;

  const nestedRpcError = (() => {
    if (typeof error !== "object" || error === null || !("response" in error)) {
      return undefined;
    }
    const data = (
      error as { response?: { data?: { error?: string | { code?: string } } } }
    ).response?.data?.error;
    if (!data) return undefined;
    return typeof data === "string" ? data : data.code;
  })();

  const rpcError = codeFromGoRpc ?? nestedRpcError;

  if (rpcError) {
    switch (rpcError) {
      case "invalid_magnet":
        return DownloadError.InvalidMagnet;
      case "metadata_timeout":
        return DownloadError.TorrentMetadataTimeout;
      case "metadata_incomplete":
        return DownloadError.TorrentMetadataIncomplete;
      case "too_many_files":
        return DownloadError.TorrentTooManyFiles;
      case "metadata_busy":
        return DownloadError.TorrentMetadataTimeout;
      default:
        return DownloadError.TorrentFilesUnavailable;
    }
  }

  return DownloadError.TorrentFilesUnavailable;
};

const getTorrentFiles = async (
  _event: Electron.IpcMainInvokeEvent,
  magnet: string
) => {
  if (!magnet || typeof magnet !== "string" || !magnet.startsWith("magnet:")) {
    return { ok: false, error: DownloadError.InvalidMagnet };
  }

  try {
    // Align with Hydra get-torrent-files defaults (30s, clamp 5–120s server-side).
    const response = await GoRPC.rpc.call<TorrentFilesResponse>(
      "torrent_files",
      {
        magnet,
        timeout_ms: 30_000,
      },
      {
        timeout: 35_000,
      }
    );

    return {
      ok: true,
      data: response.data,
    };
  } catch (error) {
    return {
      ok: false,
      error: mapTorrentFilesError(error),
    };
  }
};

registerEvent("getTorrentFiles", getTorrentFiles);
