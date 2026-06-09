package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
)

// keep existing structs: RpcRequest, RpcResponse, RpcError, ReadyEvent

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
