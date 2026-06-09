# Go RPC Migration & Cleanup Design

## 1. Overview
The goal of this project is to fully clean up the legacy "Python RPC" naming conventions left over from a previous migration and to upgrade the inter-process communication (IPC) between the Node.js backend (Electron) and the Go binary. 

Currently, the communication relies on standard input/output (`stdin/stdout`) streams, which can be brittle, difficult to type-check, and prone to buffering issues. This design outlines the transition to a local HTTP REST API hosted by the Go process.

## 2. Architecture Changes

### 2.1 From `stdio` to `HTTP`
- The Go process (`gamelaucher-go-rpc`) will act as a local HTTP server listening on `127.0.0.1`.
- A dynamic port (or a dedicated port, e.g., `5882`) will be used to prevent conflicts. 
- Node.js will communicate with the Go server using standard HTTP POST requests (via `fetch` or `axios`) instead of writing stringified JSON to `stdin`.

### 2.2 Graceful Shutdown
- Since standard `stdio` piping naturally closes when the parent process exits (triggering an EOF on `stdin`), the HTTP server needs a new termination strategy.
- Node.js will either send a request to a specific `/exit` endpoint during the Electron `before-quit` event, or the Go process will be configured to monitor the parent PID (Process ID) and self-terminate if the parent dies.

## 3. Implementation Details

### 3.1 Go Backend (`go_rpc` folder)
- **Replace Stdin Scanner**: Remove `bufio.NewScanner(os.Stdin)`.
- **Implement HTTP Server**: Use Go's standard `net/http` to create an endpoint (e.g., `POST /rpc`).
- **Data Parsing**: Parse the incoming JSON body into the existing Go structs. Respond with JSON payload directly.

### 3.2 Node.js Client (`src/main/services/`)
- **File Renaming**: Rename `python-rpc.ts` to `go-rpc.ts`.
- **Class/Variable Renaming**: 
  - `PythonRPC` -> `GoRPC`
  - `pythonRpcLogger` -> `goRpcLogger`
  - `PythonRpcMethod` -> `GoRpcMethod`, etc.
- **Client Rewrite**: Replace the `request` method that uses `process.stdin.write` with an HTTP request method. Use `axios` (already in `package.json`) to handle the request to the Go server's `/rpc` endpoint.

### 3.3 Codebase References
- Search the entire codebase for references to `PythonRPC` or `python-rpc` and update them to use `GoRPC` and `go-rpc`.
- Key files to update: `src/main/main.ts`, `src/main/services/index.ts`, `src/main/services/download-orchestrator.ts`, and any others interacting with the download logic.

## 4. Testing & Validation
- Ensure that downloading a game still correctly routes through the Go RPC.
- Ensure that the Go process properly exits when the GameLauncher application is closed.
