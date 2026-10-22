package collector

import (
	"context"
	"log"

	"github.com/s4ndyp/sync-ms/internal/disk"
	"github.com/s4ndyp/sync-ms/internal/pbstore"
	"github.com/s4ndyp/sync-ms/internal/probeclient"
	"github.com/s4ndyp/sync-ms/internal/syncthing"
)

func (c *Collector) sampleFolderDisk(ctx context.Context, inst pbstore.Instance, client *syncthing.Client, recorded string) {
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
		resolved, err := disk.ResolveExistingPath(f.Path, home)
		if err != nil {
			continue
		}
		label := f.Label
		if label == "" {
			label = f.ID
		}
		query = append(query, probeclient.QueryItem{
			FolderID:    f.ID,
			FolderLabel: label,
			Path:        resolved,
		})
	}
	if len(query) == 0 {
		return
	}

	results, err := probeclient.QueryUsage(ctx, probeBase, query)
	if err != nil {
		log.Printf("collector: disk probe %s: %v", inst.Name, err)
		return
	}
	for _, row := range results {
		if row.Error != "" {
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
		}
	}
}
