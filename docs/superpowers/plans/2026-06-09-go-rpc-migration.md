# Go RPC Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up legacy `python-rpc` code by renaming it to `go-rpc` and upgrading the IPC from `stdin/stdout` piping to a robust local HTTP server.

**Architecture:** Go process will run a local HTTP server on port 5882. Node.js will communicate with it via `axios`.

**Tech Stack:** Node.js, TypeScript, Go (`net/http`), Axios.

---

### Task 1: Refactor Go Backend to HTTP Server

**Files:**
- Modify: `go_rpc/main.go:60-128`

- [ ] **Step 1: Replace Stdin loop with HTTP server in `main.go`**

```go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
)

// ... existing structs ...

var stdoutMutex sync.Mutex

func writeResponse(resp interface{}) {
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("Failed to marshal response: %v", err)
		return
	}
	stdoutMutex.Lock()
	defer stdoutMutex.Unlock()
	fmt.Println(string(data))
}

func buildErrorResponse(id *int, code, message string) RpcResponse {
	return RpcResponse{
		Id: id,
		Error: &RpcError{
			Code:    code,
			Message: message,
		},
	}
}

func handleRpcRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req RpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		json.NewEncoder(w).Encode(buildErrorResponse(nil, "invalid_json", "Invalid JSON"))
		return
	}

	if req.Id == nil {
		json.NewEncoder(w).Encode(buildErrorResponse(nil, "invalid_request", "Missing request id"))
		return
	}

	result, err := dispatchMethod(req.Method, req.Params)
	if err != nil {
		json.NewEncoder(w).Encode(buildErrorResponse(req.Id, "internal_error", err.Error()))
		return
	}

	json.NewEncoder(w).Encode(RpcResponse{
		Id:     req.Id,
		Result: result,
	})
}

func handleExit(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	go func() {
		os.Exit(0)
	}()
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	if len(os.Args) >= 5 {
		torrentPort := os.Args[1]
		_ = torrentPort
	}

	InitTorrentClient()

	http.HandleFunc("/rpc", handleRpcRequest)
	http.HandleFunc("/exit", handleExit)

	go func() {
		if err := http.ListenAndServe("127.0.0.1:5882", nil); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	writeResponse(ReadyEvent{
		Event:           "ready",
		ProtocolVersion: 1,
	})

	// Block forever
	select {}
}

func dispatchMethod(method string, params map[string]interface{}) (interface{}, error) {
	switch method {
	case "status":
		return getStatus(), nil
	case "seed_status":
		return getSeedStatus(), nil
	case "torrent_files":
		return getTorrentFiles(params)
	case "action":
		return handleAction(params)
	default:
		return nil, fmt.Errorf("method_not_found")
	}
}
```

- [ ] **Step 2: Commit changes to Go backend**

```bash
git add go_rpc/main.go
git commit -m "refactor(go_rpc): switch to HTTP server instead of stdin"
```

---

### Task 2: Create `go-rpc.ts` Client

**Files:**
- Create: `src/main/services/go-rpc.ts`
- Modify: `src/main/services/python-rpc.ts` (Delete)

- [ ] **Step 1: Write `go-rpc.ts` with Axios**

```typescript
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { app, dialog } from "electron";
import { logger } from "./logger"; // using main logger, or create goRpcLogger later if needed

export const goRpcLogger = {
  log: (...args: any[]) => logger.info("[GoRPC]", ...args),
  error: (...args: any[]) => logger.error("[GoRPC]", ...args),
};

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
    call: async <T>(method: string, params?: unknown, config?: { timeout?: number }) => {
      const data = await GoRPC.request<T>(method, params, config);
      return { data };
    },
  };

  private static process: cp.ChildProcess | null = null;
  private static rpcPassword = "";
  private static readyPromise: Promise<void> | null = null;
  private static nextRequestId = 1;

  private static async request<T>(method: string, params?: unknown, config?: { timeout?: number }): Promise<T> {
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
        throw new GoRpcError(response.data.error.code, response.data.error.message);
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
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Go RPC startup timeout")), timeoutMs)),
    ]);
  }

  public static async spawn(initialDownload?: GamePayload, initialSeeding?: GamePayload[]) {
    if (this.process) return;

    this.rpcPassword = Math.random().toString(36).slice(2);
    let readyResolver: () => void;
    this.readyPromise = new Promise((resolve) => { readyResolver = resolve; });

    const commonArgs = [
      this.BITTORRENT_PORT,
      this.rpcPassword,
      initialDownload ? JSON.stringify(initialDownload) : "",
      initialSeeding ? JSON.stringify(initialSeeding) : "",
    ];

    const binaryPath = app.isPackaged 
      ? path.join(process.resourcesPath, "gamelaucher-go-rpc", binaryNameByPlatform[process.platform]!)
      : path.join(__dirname, "..", "..", "go_rpc", "main.go");

    if (app.isPackaged) {
      if (!fs.existsSync(binaryPath)) {
        dialog.showErrorBox("Fatal", "Game Launcher RPC binary not found.");
        app.quit();
        throw new Error("RPC binary not found");
      }
      this.process = cp.spawn(binaryPath, commonArgs, { windowsHide: true });
    } else {
      this.process = cp.spawn("go", ["run", binaryPath, ...commonArgs]);
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
```

- [ ] **Step 2: Delete `python-rpc.ts`**

```bash
rm src/main/services/python-rpc.ts
```

- [ ] **Step 3: Commit changes**

```bash
git add src/main/services/go-rpc.ts src/main/services/python-rpc.ts
git commit -m "feat: implement go-rpc client using axios"
```

---

### Task 3: Update Imports and Usages

**Files:**
- Modify: `src/main/services/index.ts`
- Modify: `src/main/services/download-orchestrator.ts` (and any other files importing PythonRPC)

- [ ] **Step 1: Replace exports in `src/main/services/index.ts`**

Open `src/main/services/index.ts`. Replace:
```typescript
export * from "./python-rpc";
```
with
```typescript
export * from "./go-rpc";
```

- [ ] **Step 2: Rename all usages across codebase**

```bash
# This is a conceptual step, actually open your IDE/files and replace:
# "PythonRPC" -> "GoRPC"
# "PythonRpcError" -> "GoRpcError"
```

- [ ] **Step 3: Commit updates**

```bash
git add src/main/services/index.ts
git commit -a -m "refactor: replace PythonRPC usages with GoRPC"
```
