import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { registerEvent } from "../register-event";
import { logger } from "@main/services";

const mimeTypesByExtension: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  ico: "image/x-icon",
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const isPrivateAddress = (address: string) => {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return (
      first === 10 ||
      first === 127 ||
      first === 0 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }

  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
};

const assertPublicHttpsUrl = (value: string) => {
  const target = new URL(value);
  if (target.protocol !== "https:" || !target.hostname) {
    throw new Error("Only HTTPS image URLs are allowed");
  }

  return target;
};

const resolvePublicAddress = async (hostname: string) => {
  const records = await lookup(hostname, { all: true });
  const record = records.find(({ address }) => !isPrivateAddress(address));

  if (!record) {
    throw new Error("Image URL resolves to a private or loopback address");
  }

  return record;
};

const fetchPinnedPublicHttps = async (
  target: URL
): Promise<IncomingMessage> => {
  const record = await resolvePublicAddress(target.hostname);

  return new Promise((resolve, reject) => {
    const request = https.get(
      target,
      {
        lookup: (_hostname, _options, callback) =>
          callback(null, record.address, record.family),
      },
      resolve
    );

    request.setTimeout(15_000, () => {
      request.destroy(new Error("Image request timed out"));
    });
    request.on("error", reject);
  });
};

const readBodyWithLimit = async (response: IncomingMessage) => {
  const contentLength = Number(response.headers["content-length"] ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error("Image exceeds the maximum allowed size");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      response.destroy();
      throw new Error("Image exceeds the maximum allowed size");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
};

const getImageDataUrl = async (
  _event: Electron.IpcMainInvokeEvent,
  imageUrl: string
): Promise<string | null> => {
  try {
    let target = assertPublicHttpsUrl(imageUrl);
    let response: IncomingMessage | undefined;
    for (
      let redirectCount = 0;
      redirectCount <= MAX_REDIRECTS;
      redirectCount += 1
    ) {
      response = await fetchPinnedPublicHttps(target);
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 300 || statusCode >= 400) break;

      const location = response.headers.location;
      if (!location) return null;
      response.resume();
      target = assertPublicHttpsUrl(
        new URL(
          Array.isArray(location) ? location[0] : location,
          target
        ).toString()
      );
    }

    if (!response || response.statusCode !== 200) {
      return null;
    }

    const rawContentType = response.headers["content-type"];
    const contentType = (
      Array.isArray(rawContentType) ? rawContentType[0] : rawContentType
    )?.split(";")[0];
    if (!contentType?.startsWith("image/")) {
      return null;
    }
    const extension = path.extname(target.pathname).toLowerCase().slice(1);
    const mimeType =
      contentType && contentType.startsWith("image/")
        ? contentType
        : mimeTypesByExtension[extension] || "image/png";

    const buffer = await readBodyWithLimit(response);
    const base64 = buffer.toString("base64");

    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    logger.error("Failed to proxy image as data URL", { imageUrl, error });
    return null;
  }
};

registerEvent("getImageDataUrl", getImageDataUrl);
