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
		"status":          4,
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

func getTorrentFiles(params map[string]interface{}) (interface{}, error) {
	magnetRaw, ok := params["magnet"].(string)
	if !ok {
		return nil, fmt.Errorf("invalid_magnet")
	}

	t, err := client.AddMagnet(magnetRaw)
	if err != nil {
		return nil, err
	}

	<-t.GotInfo()

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
		downloadsMutex.Unlock()
		return nil, nil
	case "pause_seeding":
		gameIdStr := fmt.Sprintf("%v", params["game_id"])
		downloadsMutex.Lock()
		if t, ok := seeds[gameIdStr]; ok {
			t.DisallowDataUpload()
		}
		downloadsMutex.Unlock()
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
