import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { app, dialog } from "electron";
import { goRpcLogger } from "./logger";

interface GamePayload {
  action: string;
  game_id: string;
  url: string | string[];
  save_path: string;
}

const binaryNameByPlatform: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "gamelaucher-go-rpc",
  linux: "gamelaucher-go-rpc",
  win32: "gamelaucher-go-rpc.exe",
};

export class GoRpcError extends Error {
  public readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "GoRpcError";
    this.code = code;
  }
}

export class GoRPC {
  public static readonly BITTORRENT_PORT = "5881";
  private static readonly API_URL = "http://127.0.0.1:5882/rpc";

  public static readonly rpc = {
    call: async <T>(
      method: string,
      params?: unknown,
      config?: { timeout?: number }
    ) => {
      const data = await GoRPC.request<T>(method, params, config);
      return { data };
    },
  };

  private static process: cp.ChildProcess | null = null;
  private static rpcPassword = "";
  private static readyPromise: Promise<void> | null = null;
  private static nextRequestId = 1;

  private static async request<T>(
    method: string,
    params?: unknown,
    config?: { timeout?: number }
  ): Promise<T> {
    await this.ensureReady();

    const payload = {
      id: this.nextRequestId++,
      method,
      params: params ?? {},
      rpc_password: this.rpcPassword,
    };

    try {
      const response = await axios.post(this.API_URL, payload, {
        timeout: config?.timeout ?? 10000,
      });

      if (response.data.error) {
        throw new GoRpcError(
          response.data.error.code,
          response.data.error.message
        );
      }
      return response.data.result;
    } catch (error) {
      goRpcLogger.error(`RPC request failed for method ${method}`, error);
      throw error;
    }
  }

  public static async ensureReady(timeoutMs = 10000): Promise<void> {
    if (!this.readyPromise) throw new Error("Go RPC process is not running");
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Go RPC startup timeout")), timeoutMs)
      ),
    ]);
  }

  public static async spawn(
    initialDownload?: GamePayload,
    initialSeeding?: GamePayload[]
  ) {
    if (this.process) return;

    this.rpcPassword = Math.random().toString(36).slice(2);
    let readyResolver: () => void;
    this.readyPromise = new Promise((resolve) => {
      readyResolver = resolve;
    });

    const commonArgs = [
      this.BITTORRENT_PORT,
      this.rpcPassword,
      initialDownload ? JSON.stringify(initialDownload) : "",
      initialSeeding ? JSON.stringify(initialSeeding) : "",
    ];

    const binaryName = binaryNameByPlatform[process.platform]!;
    const packagedBinaryPath = path.join(
      process.resourcesPath,
      "gamelaucher-go-rpc",
      binaryName
    );
    const devBinaryCandidates = [
      path.join(process.cwd(), "gamelaucher-go-rpc", binaryName),
      path.join(__dirname, "..", "..", "gamelaucher-go-rpc", binaryName),
    ];
    const devBinaryPath = devBinaryCandidates.find((candidate) =>
      fs.existsSync(candidate)
    );
    const goSourcePath = path.join(__dirname, "..", "..", "go_rpc", "main.go");

    const resolvedBinaryPath = app.isPackaged
      ? packagedBinaryPath
      : (devBinaryPath ?? null);

    if (resolvedBinaryPath) {
      if (!fs.existsSync(resolvedBinaryPath)) {
        dialog.showErrorBox("Fatal", "Leak Launcher RPC binary not found.");
        app.quit();
        throw new Error("RPC binary not found");
      }
      this.process = cp.spawn(resolvedBinaryPath, commonArgs, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      this.process = cp.spawn("go", ["run", goSourcePath, ...commonArgs], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    this.process.stdout?.on("data", (data) => {
      const output = data.toString();
      if (output.includes('"event":"ready"')) {
        readyResolver();
      }
    });

    this.process.on("exit", () => {
      this.process = null;
      this.readyPromise = null;
    });
  }

  public static kill() {
    if (this.process) {
      axios.post("http://127.0.0.1:5882/exit").catch(() => {});
      this.process.kill();
    }
  }
}
