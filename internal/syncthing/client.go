package syncthing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

func NewClient(baseURL, apiKey string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	return &Client{
		BaseURL: baseURL,
		APIKey:  strings.TrimSpace(apiKey),
		HTTP: &http.Client{
			Timeout: 90 * time.Second,
		},
	}
}

func (c *Client) do(ctx context.Context, method, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, nil)
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}
	return c.HTTP.Do(req)
}

type SystemStatus struct {
	MyID       string    `json:"myID"`
	TCPAddress string    `json:"tcpAddress"`
	Uptime     int       `json:"uptime"`
	StartTime  time.Time `json:"startTime"`
	Tilde      string    `json:"tilde"`
}

type FolderConfig struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

func (c *Client) SystemVersion(ctx context.Context) (string, error) {
	res, err := c.do(ctx, http.MethodGet, "/rest/system/version")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("system/version: %s", res.Status)
	}
	var out struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.Version, nil
}

func (c *Client) SystemStatus(ctx context.Context) (*SystemStatus, error) {
	res, err := c.do(ctx, http.MethodGet, "/rest/system/status")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("system/status: %s", res.Status)
	}
	var st SystemStatus
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		return nil, err
	}
	return &st, nil
}

type ConnectionsResponse struct {
	Connections map[string]ConnectionPeer `json:"connections"`
	Total       ConnectionTotals          `json:"total"`
}

type ConnectionPeer struct {
	Connected     bool      `json:"connected"`
	InBytesTotal  int64     `json:"inBytesTotal"`
	OutBytesTotal int64     `json:"outBytesTotal"`
	At            time.Time `json:"at"`
	Type          string    `json:"type"`
	Address       string    `json:"address"`
	ClientVersion string    `json:"clientVersion"`
}

type ConnectionTotals struct {
	At            time.Time `json:"at"`
	InBytesTotal  int64     `json:"inBytesTotal"`
	OutBytesTotal int64     `json:"outBytesTotal"`
}

func (c *Client) ConfigFolders(ctx context.Context) ([]FolderConfig, error) {
	res, err := c.do(ctx, http.MethodGet, "/rest/config/folders")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("config/folders: %s (%s)", res.Status, strings.TrimSpace(string(body)))
	}
	var out []FolderConfig
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) SystemConnections(ctx context.Context) (*ConnectionsResponse, error) {
	res, err := c.do(ctx, http.MethodGet, "/rest/system/connections")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("system/connections: %s (%s)", res.Status, strings.TrimSpace(string(body)))
	}
	var out ConnectionsResponse
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

type Event struct {
	ID   int             `json:"id"`
	Type string          `json:"type"`
	Time time.Time       `json:"time"`
	Data json.RawMessage `json:"data"`
}

func (c *Client) EventsSince(ctx context.Context, since int, timeoutSec int, types string) ([]Event, error) {
	path := fmt.Sprintf("/rest/events?since=%d&timeout=%d", since, timeoutSec)
	if types != "" {
		path += "&events=" + types
	}
	res, err := c.do(ctx, http.MethodGet, path)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("events: %s", res.Status)
	}
	var events []Event
	if err := json.NewDecoder(res.Body).Decode(&events); err != nil {
		return nil, err
	}
	return events, nil
}
