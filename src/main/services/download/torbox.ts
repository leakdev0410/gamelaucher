import axios, { AxiosInstance } from "axios";
import parseTorrent from "parse-torrent";
import type {
  TorBoxUserRequest,
  TorBoxTorrentInfoRequest,
  TorBoxAddTorrentRequest,
  TorBoxRequestLinkRequest,
} from "@types";
import { appVersion } from "@main/constants";

export class TorBoxClient {
  private static instance: AxiosInstance;
  private static readonly baseURL = "https://api.torbox.app/v1/api";
  private static apiToken: string;

  static authorize(apiToken: string) {
    this.apiToken = apiToken;
    this.instance = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "User-Agent": `GameLauncher/${appVersion}`,
      },
    });
  }

  private static async addMagnet(magnet: string) {
    const form = new FormData();
    form.append("magnet", magnet);

    const response = await this.instance.post<TorBoxAddTorrentRequest>(
      "/torrents/createtorrent",
      form
    );

    if (!response.data.success) {
      throw new Error(response.data.detail);
    }

    return response.data.data;
  }

  static async getTorrentInfo(id: number) {
    const response =
      await this.instance.get<TorBoxTorrentInfoRequest>("/torrents/mylist");
    const data = response.data.data;

    const info = data.find((item) => item.id === id);

    if (!info) {
      return null;
    }

    return info;
  }

  static async getUser() {
    const response = await this.instance.get<TorBoxUserRequest>(`/user/me`);
    return response.data.data;
  }

  static async requestLink(id: number) {
    const searchParams = new URLSearchParams({
      token: this.apiToken,
      torrent_id: id.toString(),
      zip_link: "true",
    });

    const response = await this.instance.get<TorBoxRequestLinkRequest>(
      "/torrents/requestdl?" + searchParams.toString()
    );

    return response.data.data;
  }

  private static async getAllTorrentsFromUser() {
    const response =
      await this.instance.get<TorBoxTorrentInfoRequest>("/torrents/mylist");

    return response.data.data;
  }

  private static async getTorrentIdAndName(magnetUri: string) {
    const userTorrents = await this.getAllTorrentsFromUser();

    const { infoHash } = await parseTorrent(magnetUri);
    const userTorrent = userTorrents.find(
      (userTorrent) => userTorrent.hash === infoHash
    );

    if (userTorrent) return { id: userTorrent.id, name: userTorrent.name };

    const torrent = await this.addMagnet(magnetUri);
    return { id: torrent.torrent_id, name: torrent.name };
  }

  private static readonly READY_POLL_INTERVAL_MS = 3000;
  private static readonly READY_MAX_ATTEMPTS = 60; // ~3 minutes

  private static isTorrentReady(
    info: Awaited<ReturnType<typeof TorBoxClient.getTorrentInfo>>
  ) {
    if (!info) return false;
    if (info.cached) return true;
    if (info.download_state === "completed" || info.download_state === "cached") {
      return true;
    }
    // progress is 0..1 when finished
    if (typeof info.progress === "number" && info.progress >= 1) {
      return true;
    }
    return false;
  }

  private static async waitUntilReady(id: number) {
    for (let attempt = 0; attempt < this.READY_MAX_ATTEMPTS; attempt++) {
      const info = await this.getTorrentInfo(id);
      if (this.isTorrentReady(info)) {
        return info;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.READY_POLL_INTERVAL_MS)
      );
    }

    throw new Error(
      `TorBox torrent ${id} was not ready after ${this.READY_MAX_ATTEMPTS} attempts`
    );
  }

  static async getDownloadInfo(uri: string) {
    const torrentData = await this.getTorrentIdAndName(uri);
    await this.waitUntilReady(torrentData.id);
    const url = await this.requestLink(torrentData.id);

    const name = torrentData.name ? `${torrentData.name}.zip` : undefined;

    return { url, name };
  }
}
