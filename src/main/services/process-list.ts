import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProcessPayload } from "./download/types";
import { logger } from "./logger";

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

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 1000;

let cachedProcesses: ProcessPayload[] | null = null;
let cachedAt = 0;
let inflight: Promise<ProcessPayload[]> | null = null;

const listWindowsProcesses = async (): Promise<ProcessPayload[]> => {
  // Single PowerShell call; JSON keeps parsing reliable across locales.
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-CimInstance Win32_Process |",
    "  Select-Object ProcessId,Name,ExecutablePath |",
    "  ConvertTo-Json -Compress",
  ].join(" ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 8000,
    }
  );

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as
    | Array<{
        ProcessId?: number;
        Name?: string;
        ExecutablePath?: string | null;
      }>
    | {
        ProcessId?: number;
        Name?: string;
        ExecutablePath?: string | null;
      };

  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return rows
    .filter((row) => typeof row.ProcessId === "number" && row.Name)
    .map((row) => ({
      pid: row.ProcessId as number,
      name: String(row.Name),
      exe: row.ExecutablePath ? String(row.ExecutablePath) : null,
      cwd: null,
      environ: null,
    }));
};

const readProcEnviron = async (
  pid: number
): Promise<Record<string, string> | null> => {
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    const environ: Record<string, string> = {};
    for (const entry of raw.split("\0")) {
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      environ[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return environ;
  } catch {
    return null;
  }
};

const listLinuxProcesses = async (): Promise<ProcessPayload[]> => {
  const dirents = await fs.readdir("/proc", { withFileTypes: true });
  const results: ProcessPayload[] = [];

  await Promise.all(
    dirents.map(async (dirent) => {
      if (!dirent.isDirectory() || !/^\d+$/.test(dirent.name)) return;

      const pid = Number.parseInt(dirent.name, 10);
      if (!Number.isFinite(pid)) return;

      try {
        const [cmdline, exeLink, cwdLink, environ] = await Promise.all([
          fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
          fs.readlink(`/proc/${pid}/exe`).catch(() => null),
          fs.readlink(`/proc/${pid}/cwd`).catch(() => null),
          readProcEnviron(pid),
        ]);

        const nameFromCmd =
          cmdline.split("\0").find(Boolean)?.split("/").pop() ?? "";
        const name =
          nameFromCmd ||
          (exeLink ? path.basename(exeLink) : "") ||
          `pid-${pid}`;

        results.push({
          pid,
          name,
          exe: exeLink,
          cwd: cwdLink,
          environ,
        });
      } catch {
        // Process may have exited mid-scan.
      }
    })
  );

  return results;
};

const listDarwinProcesses = async (): Promise<ProcessPayload[]> => {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axo", "pid=,comm="],
    {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
    }
  );

  const results: ProcessPayload[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const comm = match[2].trim();
    if (!Number.isFinite(pid) || !comm) continue;
    results.push({
      pid,
      name: path.basename(comm),
      exe: comm.startsWith("/") ? comm : null,
      cwd: null,
      environ: null,
    });
  }
  return results;
};

const listProcessesUncached = async (): Promise<ProcessPayload[]> => {
  try {
    if (process.platform === "win32") {
      return await listWindowsProcesses();
    }
    if (process.platform === "linux") {
      return await listLinuxProcesses();
    }
    if (process.platform === "darwin") {
      return await listDarwinProcesses();
    }
    return [];
  } catch (error) {
    logger.error("[process-list] Failed to list processes", error);
    return [];
  }
};

export const listSystemProcesses = async (
  options: { bypassCache?: boolean } = {}
): Promise<ProcessPayload[]> => {
  const now = Date.now();
  if (
    !options.bypassCache &&
    cachedProcesses &&
    now - cachedAt < CACHE_TTL_MS
  ) {
    return cachedProcesses;
  }

  if (inflight) {
    return inflight;
  }

  inflight = listProcessesUncached()
    .then((processes) => {
      cachedProcesses = processes;
      cachedAt = Date.now();
      return processes;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
};

export const buildSystemProcessMap = async (): Promise<SystemProcessMap> => {
  const processes = await listSystemProcesses();
  const processMap: Record<string, string[]> = {};
  const winePrefixMap: Record<string, string> = {};
  const linuxProcesses: SystemProcessMap["linuxProcesses"] = [];

  for (const proc of processes) {
    const exePath = proc.exe;
    const nameKey = proc.name.toLowerCase();

    if (exePath) {
      const basename = path.basename(exePath).toLowerCase();
      if (!processMap[basename]) processMap[basename] = [];
      if (!processMap[basename].includes(exePath)) {
        processMap[basename].push(exePath);
      }

      const withoutExt = basename.replace(/\.exe$/i, "");
      if (withoutExt !== basename) {
        if (!processMap[withoutExt]) processMap[withoutExt] = [];
        if (!processMap[withoutExt].includes(exePath)) {
          processMap[withoutExt].push(exePath);
        }
      }

      const prefix = proc.environ?.STEAM_COMPAT_DATA_PATH;
      if (prefix) {
        winePrefixMap[exePath] = prefix;
      }
    }

    if (!processMap[nameKey]) processMap[nameKey] = [];
    if (exePath && !processMap[nameKey].includes(exePath)) {
      processMap[nameKey].push(exePath);
    }

    if (process.platform === "linux") {
      linuxProcesses.push({
        name: proc.name.toLowerCase(),
        cwd: (proc.cwd ?? "").toLowerCase(),
        exe: (proc.exe ?? "").toLowerCase(),
        steamCompatDataPath: proc.environ?.STEAM_COMPAT_DATA_PATH ?? null,
      });
    }
  }

  return { processMap, winePrefixMap, linuxProcesses };
};
