/**
 * Prefer Cloudflare DNS (1.1.1.1) for app network, with hard timeouts so
 * startup never hangs if UDP/53 or DoH is filtered.
 *
 * Order per lookup:
 *  1. DNS-over-HTTPS (https://1.1.1.1/dns-query) — works even when ISP blocks
 *     plain DNS, and matches what users enable as "1.1.1.1"
 *  2. Plain DNS via 1.1.1.1 / 1.0.0.1 (UDP)
 *  3. System dns.lookup fallback
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { app } from "electron";
import { logger } from "./logger";

export const CLOUDFLARE_DNS_SERVERS = ["1.1.1.1", "1.0.0.1"] as const;

export const CLOUDFLARE_DOH_SERVERS = [
  "https://cloudflare-dns.com/dns-query",
  "https://1.1.1.1/dns-query",
  "https://1.0.0.1/dns-query",
] as const;

const DNS_TIMEOUT_MS = 2500;
const DOH_TIMEOUT_MS = 3000;

let nodeDnsInstalled = false;
let chromiumDnsInstalled = false;
let originalLookup: typeof dns.lookup | null = null;

const plainResolver = new dns.Resolver();
plainResolver.setServers([...CLOUDFLARE_DNS_SERVERS]);

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

const hostnameCache = new Map<
  string,
  { address: string; family: number; expiresAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeLookupArgs(
  options: dns.LookupOneOptions | dns.LookupAllOptions | number | undefined,
  callback: LookupCallback | undefined
): {
  options: dns.LookupOptions;
  callback: LookupCallback;
} {
  if (typeof options === "function") {
    return { options: {}, callback: options as LookupCallback };
  }
  if (typeof options === "number") {
    return {
      options: { family: options },
      callback: callback as LookupCallback,
    };
  }
  return {
    options: (options ?? {}) as dns.LookupOptions,
    callback: callback as LookupCallback,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function resolvePlain(
  hostname: string,
  rrtype: "A" | "AAAA"
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const fn =
      rrtype === "A"
        ? plainResolver.resolve4.bind(plainResolver)
        : plainResolver.resolve6.bind(plainResolver);
    fn(hostname, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses ?? []);
    });
  });
}

/**
 * Resolve via Cloudflare DoH (JSON API). Uses direct IP URL + Host header so
 * we do not recurse into our own patched lookup for the DoH endpoint itself.
 */
async function resolveDoh(
  hostname: string,
  rrtype: "A" | "AAAA"
): Promise<string[]> {
  const type = rrtype === "A" ? 1 : 28;
  // Hit 1.1.1.1 by IP to avoid chicken-and-egg DNS for the DoH host.
  const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/dns-json",
        // SNI/Host still identify Cloudflare DoH
        Host: "cloudflare-dns.com",
      },
    });

    if (!response.ok) {
      throw new Error(`DoH HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };

    const answers = (data.Answer ?? [])
      .filter((a) => a.type === type && typeof a.data === "string")
      .map((a) => a.data.replace(/\.$/, ""));

    if (!answers.length) {
      throw new Error("DoH empty answer");
    }
    return answers;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAddresses(
  hostname: string,
  preferFamily: number
): Promise<{ address: string; family: number }[]> {
  const tryOrder: Array<"A" | "AAAA"> =
    preferFamily === 6
      ? ["AAAA", "A"]
      : preferFamily === 4
        ? ["A"]
        : ["A", "AAAA"];

  const results: { address: string; family: number }[] = [];

  for (const rrtype of tryOrder) {
    const family = rrtype === "A" ? 4 : 6;

    try {
      const addresses = await withTimeout(
        resolveDoh(hostname, rrtype),
        DOH_TIMEOUT_MS,
        `DoH ${rrtype}`
      );
      for (const address of addresses) {
        results.push({ address, family });
      }
      if (results.length) return results;
    } catch {
      // try plain DNS
    }

    try {
      const addresses = await withTimeout(
        resolvePlain(hostname, rrtype),
        DNS_TIMEOUT_MS,
        `plain ${rrtype}`
      );
      for (const address of addresses) {
        results.push({ address, family });
      }
      if (results.length) return results;
    } catch {
      // next
    }
  }

  return results;
}

/**
 * Resolve hostname via Cloudflare DoH → plain 1.1.1.1 → system lookup.
 * Always invokes callback (never hangs silently).
 */
export function cloudflareLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number | undefined,
  callback?: LookupCallback
): void {
  const { options: opts, callback: cb } = normalizeLookupArgs(
    options,
    callback
  );

  // Pass through IP literals immediately.
  if (netIsIP(hostname)) {
    const family = hostname.includes(":") ? 6 : 4;
    if (opts.all) {
      cb(null, [{ address: hostname, family }]);
    } else {
      cb(null, hostname, family);
    }
    return;
  }

  const cached = hostnameCache.get(hostname.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) {
    if (opts.all) {
      cb(null, [{ address: cached.address, family: cached.family }]);
    } else {
      cb(null, cached.address, cached.family);
    }
    return;
  }

  const rawFamily = opts.family;
  const family =
    rawFamily === 6 || rawFamily === "IPv6"
      ? 6
      : rawFamily === 4 || rawFamily === "IPv4"
        ? 4
        : 0;
  const all = Boolean(opts.all);

  const finishWithSystem = () => {
    if (originalLookup) {
      originalLookup(hostname, opts as dns.LookupOptions, cb as never);
      return;
    }
    const err = new Error(
      `DNS lookup failed for ${hostname}`
    ) as NodeJS.ErrnoException;
    err.code = "ENOTFOUND";
    cb(err, all ? [] : "", 4);
  };

  void (async () => {
    try {
      const addresses = await resolveAddresses(hostname, family);
      if (!addresses.length) {
        finishWithSystem();
        return;
      }

      hostnameCache.set(hostname.toLowerCase(), {
        address: addresses[0].address,
        family: addresses[0].family,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      if (all) {
        cb(null, addresses);
      } else {
        cb(null, addresses[0].address, addresses[0].family);
      }
    } catch {
      finishWithSystem();
    }
  })();
}

function netIsIP(value: string): boolean {
  // Avoid importing net (can pull extra side effects); simple check is enough.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  if (value.includes(":") && /^[0-9a-fA-F:]+$/.test(value)) return true;
  return false;
}

/**
 * Install Node-side DNS overrides. Safe to call multiple times.
 */
export function installNodeCloudflareDns(): void {
  if (nodeDnsInstalled) return;
  nodeDnsInstalled = true;

  try {
    dns.setServers([...CLOUDFLARE_DNS_SERVERS]);
  } catch (error) {
    logger.warn("[dns] dns.setServers failed", error);
  }

  // System DNS often returns IPv6 first for Cloudflare-fronted Hydra hosts.
  // Broken IPv6 hangs catalogue/download-sources even when IPv4 is fine.
  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch {
    // older Node without setDefaultResultOrder
  }

  originalLookup = dns.lookup.bind(dns);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = cloudflareLookup;

  const agentOptions = {
    keepAlive: true,
    // Critical: lookup must use our function so agents don't call dns.lookup
    // in a way that re-enters before original is stored.
    lookup: cloudflareLookup as unknown as http.AgentOptions["lookup"],
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const axiosModule = require("axios") as {
      default?: {
        defaults: {
          httpAgent?: http.Agent;
          httpsAgent?: https.Agent;
          timeout?: number;
        };
      };
      defaults?: {
        httpAgent?: http.Agent;
        httpsAgent?: https.Agent;
        timeout?: number;
      };
    };
    const axios = axiosModule.default ?? axiosModule;
    if (axios.defaults) {
      axios.defaults.httpAgent = new http.Agent(agentOptions);
      axios.defaults.httpsAgent = new https.Agent(agentOptions);
      // Prevent infinite hangs on dead networks during startup.
      if (!axios.defaults.timeout) {
        axios.defaults.timeout = 20_000;
      }
    }
  } catch (error) {
    logger.warn("[dns] Failed to set axios default agents", error);
  }

  logger.info(
    `[dns] Node DNS via Cloudflare DoH/1.1.1.1 (timeout ${DNS_TIMEOUT_MS}ms)`
  );
}

/**
 * Chromium secure DNS. Uses "automatic" so Chromium can fall back if DoH fails,
 * avoiding a hard hang on first paint / net.fetch.
 */
export function installChromiumCloudflareDns(): void {
  if (chromiumDnsInstalled) return;
  chromiumDnsInstalled = true;

  try {
    if (typeof app.configureHostResolver === "function") {
      app.configureHostResolver({
        // "automatic" upgrades to DoH when possible but won't brick resolution.
        secureDnsMode: "automatic",
        secureDnsServers: [...CLOUDFLARE_DOH_SERVERS],
      });
      logger.info("[dns] Chromium DoH prefer Cloudflare (automatic mode)");
    } else {
      logger.warn("[dns] app.configureHostResolver is unavailable");
    }
  } catch (error) {
    logger.error("[dns] Failed to configure Chromium DoH", error);
  }
}

// Auto-install Node DNS as soon as this module is imported.
installNodeCloudflareDns();
