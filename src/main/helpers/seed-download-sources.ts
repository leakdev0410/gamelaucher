import { downloadSourcesSublevel } from "@main/level";
import { ApiClient, logger } from "@main/services";
import { DownloadSourceStatus } from "@shared";
import type { DownloadSource } from "@types";

const DEFAULT_SOURCES = [
  "https://hydralinks.cloud/sources/fitgirl.json",
  "https://hydralinks.cloud/sources/steamrip.json",
  "https://hydralinks.cloud/sources/onlinefix.json",
];

export const seedDownloadSources = async () => {
  const existingSources = await downloadSourcesSublevel.values().all();

  for (const url of DEFAULT_SOURCES) {
    const sourcesForUrl = existingSources.filter(
      (source) => source.url === url
    );

    // Older builds seeded the defaults with a locally fabricated id (and an
    // empty fingerprint). The API never knew that id, so the repacks query
    // (/games/.../download-sources?downloadSourceIds=...) resolved no download
    // options for them — making games appear undownloadable until the user
    // removed the source and re-added it through the modal. Drop those stale
    // entries so they can be re-registered with the real server-assigned id.
    const brokenSources = sourcesForUrl.filter(
      (source) =>
        source.status === DownloadSourceStatus.Matched && !source.fingerprint
    );

    for (const broken of brokenSources) {
      await downloadSourcesSublevel.del(broken.id);
    }

    const hasValidSource = sourcesForUrl.length > brokenSources.length;
    if (hasValidSource) continue;

    try {
      const downloadSource = await ApiClient.post<DownloadSource>(
        "/download-sources",
        { url },
        { needsAuth: false }
      );

      await downloadSourcesSublevel.put(downloadSource.id, {
        ...downloadSource,
        isRemote: true,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to seed download source ${url}:`, error);
    }
  }
};
