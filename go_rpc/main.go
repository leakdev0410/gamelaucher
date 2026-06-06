package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
)

type RpcRequest struct {
	Id          *int                   `json:"id"`
	Method      string                 `json:"method"`
	Params      map[string]interface{} `json:"params"`
	RpcPassword string                 `json:"rpc_password"`
}

type RpcResponse struct {
	Id     *int        `json:"id,omitempty"`
	Result interface{} `json:"result,omitempty"`
	Error  *RpcError   `json:"error,omitempty"`
}

type RpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ReadyEvent struct {
	Event           string `json:"event"`
	ProtocolVersion int    `json:"protocolVersion"`
}

var (
	stdoutMutex sync.Mutex
)

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

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// In Electron, they pass: [script, torrent_port, rpc_password, initial_download, initial_seeding]
	if len(os.Args) < 5 {
		// Just a fallback
	} else {
		torrentPort := os.Args[1]
		_ = torrentPort // Use this to init torrent client
	}

	InitTorrentClient()

	writeResponse(ReadyEvent{
		Event:           "ready",
		ProtocolVersion: 1,
	})

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var req RpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			writeResponse(buildErrorResponse(nil, "invalid_json", "Invalid JSON"))
			continue
		}

		go handleRequest(req)
	}
}

func handleRequest(req RpcRequest) {
	if req.Id == nil {
		writeResponse(buildErrorResponse(nil, "invalid_request", "Missing request id"))
		return
	}

	result, err := dispatchMethod(req.Method, req.Params)
	if err != nil {
		// Basic error mapping
		writeResponse(buildErrorResponse(req.Id, "internal_error", err.Error()))
		return
	}

	writeResponse(RpcResponse{
		Id:     req.Id,
		Result: result,
	})
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
