package collector

import (
	"context"
	"log"
	"time"

	"github.com/s4ndyp/sync-ms/internal/disk"
	"github.com/s4ndyp/sync-ms/internal/pbstore"
	"github.com/s4ndyp/sync-ms/internal/probeclient"
	"github.com/s4ndyp/sync-ms/internal/syncthing"
)

const diskProbeInterval = time.Hour

func (c *Collector) sampleFolderDisk(ctx context.Context, inst pbstore.Instance, client *syncthing.Client, recorded string) {
	c.mu.Lock()
	hasData := c.diskProbeHasData[inst.ID]
	lastProbe := c.lastDiskProbeAt[inst.ID]
	c.mu.Unlock()
	if hasData && !lastProbe.IsZero() && time.Since(lastProbe) < diskProbeInterval {
		return
	}

	probeBase, err := probeclient.BaseURLForInstance(inst.BaseURL, inst.DiskProbeHost)
	if err != nil {
		return
	}

	st, err := client.SystemStatus(ctx)
	if err != nil {
		return
	}
	home := ""
	if st != nil {
		home = st.Tilde
	}
	folders, err := client.ConfigFolders(ctx)
	if err != nil {
		log.Printf("collector: disk probe %s folders: %v", inst.Name, err)
		return
	}

	var query []probeclient.QueryItem
	for _, f := range folders {
		if f.ID == "" {
			continue
		}
		// Paths exist on the Syncthing host only — expand ~ via API, do not stat locally.
		expanded := disk.ExpandPath(f.Path, home)
		if expanded == "" || expanded == "~" {
			log.Printf("collector: disk probe %s: skip folder %s (path %q not expanded)", inst.Name, f.ID, f.Path)
			continue
		}
		label := f.Label
		if label == "" {
			label = f.ID
		}
		query = append(query, probeclient.QueryItem{
			FolderID:    f.ID,
			FolderLabel: label,
			Path:        expanded,
		})
	}
	if len(query) == 0 {
		log.Printf("collector: disk probe %s: no folders to query (Syncthing folders empty or paths unusable)", inst.Name)
		return
	}

	results, err := probeclient.QueryUsage(ctx, probeBase, query)
	if err != nil {
		log.Printf("collector: disk probe %s: %v", inst.Name, err)
		return
	}
	var saved int
	for _, row := range results {
		if row.Error != "" {
			log.Printf("collector: disk probe %s folder %s: %s", inst.Name, row.FolderID, row.Error)
			continue
		}
		label := row.FolderLabel
		if label == "" {
			label = row.FolderID
		}
		if err := c.store.CreateFolderDiskSample(ctx, map[string]any{
			"instance":     inst.ID,
			"folder_id":    row.FolderID,
			"folder_label": label,
			"recorded_at":  recorded,
			"free_bytes":   row.FreeBytes,
			"total_bytes":  row.TotalBytes,
			"source":       "probe",
		}); err != nil {
			log.Printf("collector: folder disk %s/%s: %v", inst.Name, row.FolderID, err)
			continue
		}
		saved++
	}
	if saved > 0 {
		c.mu.Lock()
		c.diskProbeHasData[inst.ID] = true
		c.lastDiskProbeAt[inst.ID] = time.Now().UTC()
		c.mu.Unlock()
	}
}
