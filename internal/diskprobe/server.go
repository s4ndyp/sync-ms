package diskprobe

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/s4ndyp/sync-ms/internal/disk"
)

type UsageItem struct {
	FolderID string `json:"folder_id"`
	Path     string `json:"path"`
}

type usageRequest struct {
	Items []UsageItem `json:"items"`
}

type usageResult struct {
	FolderID   string `json:"folder_id"`
	FreeBytes  uint64 `json:"free_bytes"`
	TotalBytes uint64 `json:"total_bytes"`
	Error      string `json:"error,omitempty"`
}

type usageResponse struct {
	Items []usageResult `json:"items"`
}

const maxBodyBytes = 256 << 10
const maxItems = 128

func NewServer() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("POST /v1/usage", handleUsage)
	return mux
}

func ListenAddr() string {
	return fmt.Sprintf(":%d", DefaultPort)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "port": DefaultPort})
}

func handleUsage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body too large"})
		return
	}
	var req usageRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(req.Items) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "items[] required"})
		return
	}
	if len(req.Items) > maxItems {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many items"})
		return
	}

	out := make([]usageResult, 0, len(req.Items))
	for _, it := range req.Items {
		folderID := strings.TrimSpace(it.FolderID)
		path := strings.TrimSpace(it.Path)
		if path == "" {
			out = append(out, usageResult{FolderID: folderID, Error: "path required"})
			continue
		}
		resolved, err := disk.ResolveExistingPath(path, "")
		if err != nil {
			out = append(out, usageResult{FolderID: folderID, Error: "path not accessible"})
			continue
		}
		free, total, err := disk.Usage(resolved)
		if err != nil {
			out = append(out, usageResult{FolderID: folderID, Error: "statfs failed"})
			continue
		}
		out = append(out, usageResult{
			FolderID:   folderID,
			FreeBytes:  free,
			TotalBytes: total,
		})
	}
	writeJSON(w, http.StatusOK, usageResponse{Items: out})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func Run() error {
	srv := &http.Server{
		Addr:              ListenAddr(),
		Handler:           NewServer(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	log.Printf("syncms-disk-probe listening on %s (no auth)", ListenAddr())
	return srv.ListenAndServe()
}
