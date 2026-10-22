package probeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/s4ndyp/sync-ms/internal/diskprobe"
)

type QueryItem struct {
	FolderID    string
	FolderLabel string
	Path        string
}

type ResultItem struct {
	FolderID    string
	FolderLabel string
	FreeBytes   uint64
	TotalBytes  uint64
	Error       string
}

type clientReq struct {
	Items []struct {
		FolderID string `json:"folder_id"`
		Path     string `json:"path"`
	} `json:"items"`
}

type clientResp struct {
	Items []struct {
		FolderID   string `json:"folder_id"`
		FreeBytes  uint64 `json:"free_bytes"`
		TotalBytes uint64 `json:"total_bytes"`
		Error      string `json:"error"`
	} `json:"items"`
}

// BaseURLForInstance returns http://host:8765 from Syncthing base_url unless disk_probe_host overrides.
func BaseURLForInstance(syncthingBaseURL, diskProbeHost string) (string, error) {
	hostField := strings.TrimSpace(diskProbeHost)
	if hostField != "" {
		if strings.HasPrefix(hostField, "http://") || strings.HasPrefix(hostField, "https://") {
			return strings.TrimRight(hostField, "/"), nil
		}
		if strings.Contains(hostField, ":") {
			return "http://" + hostField, nil
		}
		return fmt.Sprintf("http://%s:%d", hostField, diskprobe.DefaultPort), nil
	}
	u, err := url.Parse(strings.TrimSpace(syncthingBaseURL))
	if err != nil {
		return "", err
	}
	h := u.Hostname()
	if h == "" {
		return "", fmt.Errorf("no host in syncthing base_url")
	}
	return fmt.Sprintf("http://%s:%d", h, diskprobe.DefaultPort), nil
}

func QueryUsage(ctx context.Context, probeBase string, items []QueryItem) ([]ResultItem, error) {
	if len(items) == 0 {
		return nil, nil
	}
	var body clientReq
	for _, it := range items {
		body.Items = append(body.Items, struct {
			FolderID string `json:"folder_id"`
			Path     string `json:"path"`
		}{FolderID: it.FolderID, Path: it.Path})
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, probeBase+"/v1/usage", bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 512<<10))
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("probe HTTP %s: %s", res.Status, strings.TrimSpace(string(raw)))
	}
	var parsed clientResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	labelByID := make(map[string]string, len(items))
	for _, it := range items {
		labelByID[it.FolderID] = it.FolderLabel
	}
	out := make([]ResultItem, 0, len(parsed.Items))
	for _, row := range parsed.Items {
		out = append(out, ResultItem{
			FolderID:    row.FolderID,
			FolderLabel: labelByID[row.FolderID],
			FreeBytes:   row.FreeBytes,
			TotalBytes:  row.TotalBytes,
			Error:       row.Error,
		})
	}
	return out, nil
}
