package pbstore

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
)

type Store struct {
	BaseURL string
	HTTP    *http.Client
}

func New(baseURL string) *Store {
	return &Store{
		BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		HTTP: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

type ListResult[T any] struct {
	Page       int `json:"page"`
	PerPage    int `json:"perPage"`
	TotalItems int `json:"totalItems"`
	TotalPages int `json:"totalPages"`
	Items      []T `json:"items"`
}

type Instance struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	BaseURL         string `json:"base_url"`
	APIKey          string `json:"api_key"`
	Enabled         bool   `json:"enabled"`
	SyncthingID     string `json:"syncthing_id"`
	LastEventID     int    `json:"last_event_id"`
	Online          bool   `json:"online"`
	LastSeen        string `json:"last_seen"`
	LastError       string `json:"last_error"`
	InBytesTotal    int64  `json:"in_bytes_total"`
	OutBytesTotal   int64  `json:"out_bytes_total"`
	InBytesAlltime  int64  `json:"in_bytes_alltime"`
	OutBytesAlltime int64  `json:"out_bytes_alltime"`
	InSpeedBps      float64 `json:"in_speed_bps"`
	OutSpeedBps     float64 `json:"out_speed_bps"`
	Version         string `json:"version"`
	SampleCount     int    `json:"sample_count"`
	LastSampleAt  string `json:"last_sample_at"`
	DiskProbeHost string `json:"disk_probe_host"`
}

func (s *Store) ListInstances(ctx context.Context) ([]Instance, error) {
	return listAll[Instance](ctx, s, "instances", url.Values{
		"filter": {"enabled=true"},
		"sort":   {"name"},
	})
}

func (s *Store) ListAllInstances(ctx context.Context) ([]Instance, error) {
	return listAll[Instance](ctx, s, "instances", url.Values{"sort": {"name"}})
}

func (s *Store) PatchInstance(ctx context.Context, id string, fields map[string]any) error {
	return s.patchRecord(ctx, "instances", id, fields)
}

type TransferSample struct {
	ID            string  `json:"id"`
	Instance      string  `json:"instance"`
	RecordedAt    string  `json:"recorded_at"`
	InBytesTotal  int64   `json:"in_bytes_total"`
	OutBytesTotal int64   `json:"out_bytes_total"`
	InBytesDelta  int64   `json:"in_bytes_delta"`
	OutBytesDelta int64   `json:"out_bytes_delta"`
	InSpeedBps    float64 `json:"in_speed_bps"`
	OutSpeedBps   float64 `json:"out_speed_bps"`
}

func (s *Store) CreateSample(ctx context.Context, sample map[string]any) error {
	return s.createRecord(ctx, "transfer_samples", sample)
}

type TransferHourly struct {
	ID            string  `json:"id"`
	Instance      string  `json:"instance"`
	BucketStart   string  `json:"bucket_start"`
	InBytesDelta  int64   `json:"in_bytes_delta"`
	OutBytesDelta int64   `json:"out_bytes_delta"`
}

func (s *Store) FindHourly(ctx context.Context, instanceID, bucketStart string) (*TransferHourly, error) {
	filter := fmt.Sprintf(`instance="%s" && bucket_start="%s"`, instanceID, bucketStart)
	items, err := listAll[TransferHourly](ctx, s, "transfer_hourly", url.Values{
		"filter": {filter},
		"perPage": {"1"},
	})
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

func (s *Store) CreateHourly(ctx context.Context, row map[string]any) error {
	return s.createRecord(ctx, "transfer_hourly", row)
}

func (s *Store) PatchHourly(ctx context.Context, id string, fields map[string]any) error {
	return s.patchRecord(ctx, "transfer_hourly", id, fields)
}

func (s *Store) ListSamplesSince(ctx context.Context, instanceID string, since time.Time) ([]TransferSample, error) {
	filter := fmt.Sprintf(`instance="%s" && recorded_at >= "%s"`, instanceID, formatPBTime(since))
	return listAll[TransferSample](ctx, s, "transfer_samples", url.Values{
		"filter": {filter},
		"sort":   {"recorded_at"},
	})
}

func (s *Store) DeleteSamplesBefore(ctx context.Context, before time.Time) (int, error) {
	filter := fmt.Sprintf(`recorded_at < "%s"`, formatPBTime(before))
	return s.deleteByFilter(ctx, "transfer_samples", filter)
}

func (s *Store) CreateFolderDiskSample(ctx context.Context, sample map[string]any) error {
	return s.createRecord(ctx, "folder_disk_samples", sample)
}

func (s *Store) DeleteFolderDiskSamplesBefore(ctx context.Context, before time.Time) (int, error) {
	filter := fmt.Sprintf(`recorded_at < "%s"`, formatPBTime(before))
	return s.deleteByFilter(ctx, "folder_disk_samples", filter)
}

func (s *Store) DeleteFolderDiskSamplesExcept(ctx context.Context, instanceID string, keepFolderIDs []string) (int, error) {
	keep := make(map[string]struct{}, len(keepFolderIDs))
	for _, id := range keepFolderIDs {
		id = strings.TrimSpace(id)
		if id != "" {
			keep[id] = struct{}{}
		}
	}
	filter := fmt.Sprintf(`instance="%s"`, instanceID)
	type folderDiskRef struct {
		ID       string `json:"id"`
		FolderID string `json:"folder_id"`
	}
	rows, err := listAll[folderDiskRef](ctx, s, "folder_disk_samples", url.Values{
		"filter": {filter},
		"fields": {"id,folder_id"},
	})
	if err != nil {
		return 0, err
	}
	var removed int
	for _, row := range rows {
		if _, ok := keep[row.FolderID]; ok {
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, s.BaseURL+"/api/collections/folder_disk_samples/records/"+row.ID, nil)
		if err != nil {
			return removed, err
		}
		res, err := s.HTTP.Do(req)
		if err != nil {
			return removed, err
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNoContent {
			return removed, fmt.Errorf("DELETE folder_disk_samples/%s: %s", row.ID, res.Status)
		}
		removed++
	}
	return removed, nil
}

func formatPBTime(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04:05.000Z")
}

func listAll[T any](ctx context.Context, s *Store, collection string, params url.Values) ([]T, error) {
	if params == nil {
		params = url.Values{}
	}
	if params.Get("perPage") == "" {
		params.Set("perPage", "200")
	}
	var all []T
	page := 1
	for {
		params.Set("page", fmt.Sprintf("%d", page))
		var res ListResult[T]
		if err := s.getJSON(ctx, "/api/collections/"+collection+"/records?"+params.Encode(), &res); err != nil {
			return nil, err
		}
		all = append(all, res.Items...)
		if page >= res.TotalPages || res.TotalPages == 0 {
			break
		}
		page++
	}
	return all, nil
}

func (s *Store) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseURL+path, nil)
	if err != nil {
		return err
	}
	res, err := s.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("GET %s: %s %s", path, res.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (s *Store) createRecord(ctx context.Context, collection string, body map[string]any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.BaseURL+"/api/collections/"+collection+"/records", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("POST %s: %s %s", collection, res.Status, strings.TrimSpace(string(raw)))
	}
	return nil
}

func (s *Store) patchRecord(ctx context.Context, collection, id string, body map[string]any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, s.BaseURL+"/api/collections/"+collection+"/records/"+id, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("PATCH %s/%s: %s %s", collection, id, res.Status, strings.TrimSpace(string(raw)))
	}
	return nil
}

func (s *Store) deleteByFilter(ctx context.Context, collection, filter string) (int, error) {
	items, err := listAll[struct {
		ID string `json:"id"`
	}](ctx, s, collection, url.Values{"filter": {filter}, "fields": {"id"}})
	if err != nil {
		return 0, err
	}
	for _, it := range items {
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, s.BaseURL+"/api/collections/"+collection+"/records/"+it.ID, nil)
		if err != nil {
			return 0, err
		}
		res, err := s.HTTP.Do(req)
		if err != nil {
			return 0, err
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNoContent {
			return 0, fmt.Errorf("DELETE %s: %s", it.ID, res.Status)
		}
	}
	return len(items), nil
}

func (s *Store) WaitReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.BaseURL+"/api/health", nil)
		if err == nil {
			res, err := s.HTTP.Do(req)
			if err == nil {
				res.Body.Close()
				if res.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("pocketbase not ready after %s", timeout)
}
