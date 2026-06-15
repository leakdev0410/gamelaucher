import axios, { AxiosInstance } from "axios";
import https from "node:https";
import parseTorrent from "parse-torrent";
import type {
  RealDebridAddMagnet,
  RealDebridTorrentInfo,
  RealDebridUnrestrictLink,
  RealDebridUser,
} from "@types";

export class RealDebridClient {
  private static instance: AxiosInstance;
  private static readonly baseURL = "https://api.real-debrid.com/rest/1.0";

  private static readonly TORRENT_POLL_INTERVAL_MS = 5000;
  private static readonly TORRENT_MAX_ATTEMPTS = 120; // 10 minutes

  static authorize(apiToken: string) {
    this.instance = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      httpsAgent: new https.Agent({ family: 4 }),
    });
  }

  static async addMagnet(magnet: string) {
    const searchParams = new URLSearchParams({ magnet });

    const response = await this.instance.post<RealDebridAddMagnet>(
      "/torrents/addMagnet",
      searchParams.toString()
    );

    return response.data;
  }

  static async getTorrentInfo(id: string) {
    const response = await this.instance.get<RealDebridTorrentInfo>(
      `/torrents/info/${id}`
    );
    return response.data;
  }

  static async getUser() {
    const response = await this.instance.get<RealDebridUser>(`/user`);
    return response.data;
  }

  static async selectAllFiles(id: string) {
    const searchParams = new URLSearchParams({ files: "all" });

    return this.instance.post(
      `/torrents/selectFiles/${id}`,
      searchParams.toString()
    );
  }

  static async unrestrictLink(link: string) {
    const searchParams = new URLSearchParams({ link });

    const response = await this.instance.post<RealDebridUnrestrictLink>(
      "/unrestrict/link",
      searchParams.toString()
    );

    return response.data;
  }

  private static async getAllTorrentsFromUser() {
    const response =
      await this.instance.get<RealDebridTorrentInfo[]>("/torrents");

    return response.data;
  }

  static async getTorrentId(magnetUri: string) {
    const userTorrents = await RealDebridClient.getAllTorrentsFromUser();

    const { infoHash } = await parseTorrent(magnetUri);
    const userTorrent = userTorrents.find(
      (userTorrent) => userTorrent.hash === infoHash
    );

    if (userTorrent) return userTorrent.id;

    const torrent = await RealDebridClient.addMagnet(magnetUri);
    return torrent.id;
  }

  private static async waitForTorrentDownload(
    torrentId: string
  ): Promise<RealDebridTorrentInfo> {
    for (let attempt = 1; attempt <= this.TORRENT_MAX_ATTEMPTS; attempt++) {
      const torrentInfo = await this.getTorrentInfo(torrentId);

      if (torrentInfo.status === "downloaded") {
        return torrentInfo;
      }

      if (
        torrentInfo.status === "error" ||
        torrentInfo.status === "virus" ||
        torrentInfo.status === "dead" ||
        torrentInfo.status === "magnet_error"
      ) {
        throw new Error(
          `[RealDebrid] Torrent ${torrentId} failed: ${torrentInfo.status}`
        );
      }

      await new Promise((resolve) =>
        setTimeout(resolve, this.TORRENT_POLL_INTERVAL_MS)
      );
    }

    throw new Error(
      `[RealDebrid] Torrent ${torrentId} timed out after ${this.TORRENT_MAX_ATTEMPTS} attempts`
    );
  }

  public static async getDownloadUrl(uri: string) {
    let realDebridTorrentId: string | null = null;

    if (uri.startsWith("magnet:")) {
      realDebridTorrentId = await this.getTorrentId(uri);
    }

    if (realDebridTorrentId) {
      let torrentInfo = await this.getTorrentInfo(realDebridTorrentId);

      if (torrentInfo.status === "waiting_files_selection") {
        await this.selectAllFiles(realDebridTorrentId);

        torrentInfo = await this.getTorrentInfo(realDebridTorrentId);
      }

      if (torrentInfo.status !== "downloaded") {
        torrentInfo = await this.waitForTorrentDownload(realDebridTorrentId);
      }

      const [link] = torrentInfo.links;
      const { download } = await this.unrestrictLink(link);
      return decodeURIComponent(download);
    }

    const { download } = await this.unrestrictLink(uri);

    return decodeURIComponent(download);
  }
}
