package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/storage"
)

var (
	client          *torrent.Client
	downloads       = make(map[string]*torrent.Torrent)
	seeds           = make(map[string]*torrent.Torrent)
	downloadsMutex  sync.Mutex
	downloadingGame string

	lastSpeedSampleTime  time.Time
	lastSpeedSampleBytes int64
	downloadSpeed        float64
)

func parseTimeoutMs(params map[string]interface{}, fallback int) time.Duration {
	raw, ok := params["timeout_ms"]
	if !ok {
		raw = params["metadata_timeout_ms"]
	}
	ms := fallback
	switch v := raw.(type) {
	case float64:
		ms = int(v)
	case int:
		ms = v
	case int64:
		ms = int(v)
	}
	if ms < 5000 {
		ms = 5000
	}
	if ms > 120000 {
		ms = 120000
	}
	return time.Duration(ms) * time.Millisecond
}

func waitForInfo(t *torrent.Torrent, timeout time.Duration) error {
	if t.Info() != nil {
		return nil
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-t.GotInfo():
		if t.Info() == nil {
			return fmt.Errorf("metadata_incomplete")
		}
		return nil
	case <-timer.C:
		return fmt.Errorf("metadata_timeout")
	}
}

// InitTorrentClient uses anacrolix defaults (ephemeral port, DHT, etc.).
// Forcing a fixed listen port / custom ListenHost regressed peer discovery on
// some Windows networks — keep defaults like the pre-rewrite engine.
func InitTorrentClient() {
	config := torrent.NewDefaultClientConfig()
	config.DataDir = os.TempDir()
	var err error
	client, err = torrent.NewClient(config)
	if err != nil {
		log.Fatalf("Error creating torrent client: %v", err)
	}
}

func getStatus() interface{} {
	downloadsMutex.Lock()
	defer downloadsMutex.Unlock()

	if downloadingGame == "" {
		return nil
	}

	t, ok := downloads[downloadingGame]
	if !ok {
		return nil
	}

	stats := t.Stats()
	info := t.Info()

	folderName := ""
	fileSize := int64(0)
	if info != nil {
		folderName = info.Name
		fileSize = info.TotalLength()
	}

	bytesDownloaded := t.BytesCompleted()
	progress := float64(0)
	if fileSize > 0 {
		progress = float64(bytesDownloaded) / float64(fileSize)
	}

	statusCode := 2 // downloading_metadata
	if info != nil {
		if fileSize > 0 && bytesDownloaded >= fileSize {
			statusCode = 4 // finished
		} else {
			statusCode = 3 // downloading
		}
	}

	now := time.Now()
	if !lastSpeedSampleTime.IsZero() {
		elapsed := now.Sub(lastSpeedSampleTime).Seconds()
		if elapsed > 0 {
			delta := bytesDownloaded - lastSpeedSampleBytes
			if delta < 0 {
				delta = 0
			}
			downloadSpeed = float64(delta) / elapsed
		}
	}
	lastSpeedSampleTime = now
	lastSpeedSampleBytes = bytesDownloaded

	return map[string]interface{}{
		"folderName":      folderName,
		"fileSize":        fileSize,
		"progress":        progress,
		"downloadSpeed":   downloadSpeed,
		"uploadSpeed":     0,
		"numPeers":        stats.ActivePeers,
		"numSeeds":        stats.ConnectedSeeders,
		"status":          statusCode,
		"bytesDownloaded": bytesDownloaded,
	}
}

func getSeedStatus() interface{} {
	downloadsMutex.Lock()
	defer downloadsMutex.Unlock()

	var result []interface{}
	for gameId, t := range seeds {
		stats := t.Stats()
		info := t.Info()

		folderName := ""
		fileSize := int64(0)
		if info != nil {
			folderName = info.Name
			fileSize = info.TotalLength()
		}

		bytesDownloaded := t.BytesCompleted()

		result = append(result, map[string]interface{}{
			"gameId":          gameId,
			"folderName":      folderName,
			"fileSize":        fileSize,
			"progress":        float64(1),
			"downloadSpeed":   0,
			"uploadSpeed":     0,
			"numPeers":        stats.ActivePeers,
			"numSeeds":        stats.ConnectedSeeders,
			"status":          5,
			"bytesDownloaded": bytesDownloaded,
		})
	}
	return result
}

func dropTorrentHandle(gameIdStr string) {
	if t, ok := downloads[gameIdStr]; ok {
		t.Drop()
		delete(downloads, gameIdStr)
	}
	if t, ok := seeds[gameIdStr]; ok {
		t.Drop()
		delete(seeds, gameIdStr)
	}
	if downloadingGame == gameIdStr {
		downloadingGame = ""
	}
}

// releaseTorrentFiles drops in-memory torrent handles so completed payload files on
// disk are not locked. On-disk data is preserved; resume_seeding re-attaches later.
func releaseTorrentFiles(params map[string]interface{}) {
	gameIdStr := fmt.Sprintf("%v", params["game_id"])
	url, _ := params["url"].(string)
	folderName, _ := params["folder_name"].(string)

	downloadsMutex.Lock()

	dropTorrentHandle(gameIdStr)

	if client != nil {
		for _, t := range client.Torrents() {
			info := t.Info()
			// Drop by torrent display name (folder) — covers seeds not in maps.
			if folderName != "" && info != nil && info.Name == folderName {
				t.Drop()
				continue
			}
		}

		if url != "" {
			if spec, err := torrent.TorrentSpecFromMagnetUri(strings.TrimSpace(url)); err == nil {
				if existing, ok := client.Torrent(spec.InfoHash); ok {
					existing.Drop()
				}
			}
		}

		// Second pass: drop again by game maps + any residual matching folder.
		dropTorrentHandle(gameIdStr)
		if folderName != "" {
			for _, t := range client.Torrents() {
				info := t.Info()
				if info != nil && info.Name == folderName {
					t.Drop()
				}
			}
		}
	}

	downloadsMutex.Unlock()

	// Give the OS / anacrolix storage layer time to close file handles after Drop.
	// Without this, 7-Zip often hits sharing violations on large archives.
	time.Sleep(750 * time.Millisecond)
}

func getTorrentFiles(params map[string]interface{}) (interface{}, error) {
	magnetRaw, ok := params["magnet"].(string)
	if !ok || !strings.HasPrefix(strings.TrimSpace(magnetRaw), "magnet:") {
		return nil, fmt.Errorf("invalid_magnet")
	}

	t, err := client.AddMagnet(strings.TrimSpace(magnetRaw))
	if err != nil {
		return nil, err
	}
	defer t.Drop()

	timeout := parseTimeoutMs(params, 30_000)
	if err := waitForInfo(t, timeout); err != nil {
		return nil, err
	}

	info := t.Info()
	files := []map[string]interface{}{}
	for i, f := range info.UpvertedFiles() {
		files = append(files, map[string]interface{}{
			"index":  i,
			"path":   strings.Join(f.Path, "/"),
			"length": f.Length,
		})
	}

	return map[string]interface{}{
		"infoHash":  t.InfoHash().HexString(),
		"name":      info.Name,
		"totalSize": info.TotalLength(),
		"files":     files,
	}, nil
}

func handleAction(params map[string]interface{}) (interface{}, error) {
	action, _ := params["action"].(string)

	switch action {
	case "start":
		url, _ := params["url"].(string)
		savePath, _ := params["save_path"].(string)

		gameIdStr := fmt.Sprintf("%v", params["game_id"])

		spec, err := torrent.TorrentSpecFromMagnetUri(url)
		if err != nil {
			return nil, err
		}

		if existing, ok := client.Torrent(spec.InfoHash); ok {
			existing.Drop()
		}

		if savePath != "" {
			if err := os.MkdirAll(savePath, 0o755); err != nil {
				return nil, err
			}
			spec.Storage = storage.NewFile(savePath)
		}

		t, _, err := client.AddTorrentSpec(spec)
		if err != nil {
			return nil, err
		}

		go func() {
			<-t.GotInfo()
			t.DownloadAll()
		}()

		downloadsMutex.Lock()
		downloads[gameIdStr] = t
		downloadingGame = gameIdStr
		lastSpeedSampleTime = time.Time{}
		lastSpeedSampleBytes = 0
		downloadSpeed = 0
		downloadsMutex.Unlock()

		return nil, nil
	case "pause":
		gameIdStr := fmt.Sprintf("%v", params["game_id"])
		downloadsMutex.Lock()
		if t, ok := downloads[gameIdStr]; ok {
			t.DisallowDataDownload()
			t.DisallowDataUpload()
		}
		downloadsMutex.Unlock()
		return nil, nil
	case "cancel":
		gameIdStr := fmt.Sprintf("%v", params["game_id"])
		downloadsMutex.Lock()
		dropTorrentHandle(gameIdStr)
		downloadsMutex.Unlock()
		return nil, nil
	case "release_files":
		releaseTorrentFiles(params)
		return nil, nil
	case "pause_seeding":
		gameIdStr := fmt.Sprintf("%v", params["game_id"])
		downloadsMutex.Lock()
		if t, ok := seeds[gameIdStr]; ok {
			t.DisallowDataUpload()
		}
		downloadsMutex.Unlock()
		return nil, nil
	case "set_download_limit":
		// Speed limit handled in Electron for HTTP downloads; no-op for torrent.
		return nil, nil
	case "resume_seeding":
		url, _ := params["url"].(string)
		savePath, _ := params["save_path"].(string)
		gameIdStr := fmt.Sprintf("%v", params["game_id"])

		spec, err := torrent.TorrentSpecFromMagnetUri(url)
		if err != nil {
			return nil, err
		}

		if savePath != "" {
			spec.Storage = storage.NewFile(savePath)
		}

		downloadsMutex.Lock()
		if existing, ok := client.Torrent(spec.InfoHash); ok {
			t := existing
			t.AllowDataUpload()
			t.DownloadAll()
			delete(downloads, gameIdStr)
			seeds[gameIdStr] = t
		} else {
			t, _, err := client.AddTorrentSpec(spec)
			if err != nil {
				downloadsMutex.Unlock()
				return nil, err
			}
			go func() {
				<-t.GotInfo()
				t.DownloadAll()
			}()
			delete(downloads, gameIdStr)
			seeds[gameIdStr] = t
		}
		if downloadingGame == gameIdStr {
			downloadingGame = ""
		}
		downloadsMutex.Unlock()
		return nil, nil
	default:
		return nil, nil
	}
}
