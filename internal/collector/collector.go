package collector

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/s4ndyp/sync-ms/internal/pbstore"
	"github.com/s4ndyp/sync-ms/internal/syncthing"
)

type Config struct {
	PocketBaseURL      string
	SampleIntervalSec  int
	RollupEverySamples int
	RetentionDays      int
}

type Collector struct {
	cfg    Config
	store  *pbstore.Store
	stopCh chan struct{}
	wg     sync.WaitGroup

	mu      sync.Mutex
	lastIn  map[string]int64
	lastOut map[string]int64
	lastAt  map[string]time.Time
}

func New(cfg Config) *Collector {
	if cfg.SampleIntervalSec <= 0 {
		cfg.SampleIntervalSec = 60
	}
	if cfg.RollupEverySamples <= 0 {
		cfg.RollupEverySamples = 60
	}
	return &Collector{
		cfg:     cfg,
		store:   pbstore.New(cfg.PocketBaseURL),
		stopCh:  make(chan struct{}),
		lastIn:  make(map[string]int64),
		lastOut: make(map[string]int64),
		lastAt:  make(map[string]time.Time),
	}
}

func (c *Collector) Stop() {
	close(c.stopCh)
	c.wg.Wait()
}

func (c *Collector) Run() {
	ctx := context.Background()
	if err := c.store.WaitReady(ctx, 5*time.Minute); err != nil {
		log.Printf("collector: pocketbase wait: %v", err)
		return
	}
	log.Println("collector: pocketbase ready")

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.retentionLoop()
	}()

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.supervisorLoop()
	}()
}

func (c *Collector) supervisorLoop() {
	active := make(map[string]context.CancelFunc)
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()

	for {
		select {
		case <-c.stopCh:
			for _, cancel := range active {
				cancel()
			}
			return
		case <-tick.C:
			ctx := context.Background()
			instances, err := c.store.ListInstances(ctx)
			if err != nil {
				log.Printf("collector: list instances: %v", err)
				continue
			}
			seen := make(map[string]struct{}, len(instances))
			for _, inst := range instances {
				seen[inst.ID] = struct{}{}
				if _, ok := active[inst.ID]; ok {
					continue
				}
				instCtx, cancel := context.WithCancel(context.Background())
				active[inst.ID] = cancel
				c.wg.Add(2)
				go func(i pbstore.Instance) {
					defer c.wg.Done()
					c.eventLoop(instCtx, i)
				}(inst)
				go func(i pbstore.Instance) {
					defer c.wg.Done()
					c.sampleLoop(instCtx, i)
				}(inst)
			}
			for id, cancel := range active {
				if _, ok := seen[id]; !ok {
					cancel()
					delete(active, id)
				}
			}
		}
	}
}

func (c *Collector) eventLoop(ctx context.Context, inst pbstore.Instance) {
	client := syncthing.NewClient(inst.BaseURL, inst.APIKey)
	eventSince := inst.LastEventID
	log.Printf("collector: events %s (%s)", inst.Name, inst.BaseURL)

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		default:
		}

		evCtx, cancel := context.WithTimeout(ctx, 70*time.Second)
		events, err := client.EventsSince(evCtx, eventSince, 55,
			"DeviceConnected,DeviceDisconnected,StartupComplete,FolderSummary")
		cancel()
		if err != nil {
			c.markOffline(ctx, inst, err)
			if !sleepOrStop(ctx, c.stopCh, 10*time.Second) {
				return
			}
			continue
		}

		if len(events) > 0 {
			eventSince = events[len(events)-1].ID
			_ = c.store.PatchInstance(ctx, inst.ID, map[string]any{
				"last_event_id": eventSince,
				"online":        true,
				"last_seen":     time.Now().UTC().Format(time.RFC3339Nano),
				"last_error":    "",
			})
		}

		for _, ev := range events {
			if ev.Type == "StartupComplete" {
				c.takeSample(ctx, inst, client)
			}
		}
	}
}

func (c *Collector) sampleLoop(ctx context.Context, inst pbstore.Instance) {
	client := syncthing.NewClient(inst.BaseURL, inst.APIKey)
	tick := time.NewTicker(time.Duration(c.cfg.SampleIntervalSec) * time.Second)
	defer tick.Stop()

	c.takeSample(ctx, inst, client)

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		case <-tick.C:
			c.takeSample(ctx, inst, client)
		}
	}
}

func sleepOrStop(ctx context.Context, stopCh <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-stopCh:
		return false
	case <-t.C:
		return true
	}
}

func (c *Collector) takeSample(ctx context.Context, inst pbstore.Instance, client *syncthing.Client) {
	conn, err := client.SystemConnections(ctx)
	if err != nil {
		c.markOffline(ctx, inst, err)
		return
	}

	st, _ := client.SystemStatus(ctx)
	version, _ := client.SystemVersion(ctx)
	syncthingID := inst.SyncthingID
	if st != nil && st.MyID != "" {
		syncthingID = st.MyID
	}

	inTotal := conn.Total.InBytesTotal
	outTotal := conn.Total.OutBytesTotal
	now := time.Now().UTC()

	var inDelta, outDelta int64
	var inSpeed, outSpeed float64

	c.mu.Lock()
	prevIn := c.lastIn[inst.ID]
	prevOut := c.lastOut[inst.ID]
	prevAt := c.lastAt[inst.ID]
	if !prevAt.IsZero() && now.After(prevAt) {
		dt := now.Sub(prevAt).Seconds()
		if dt > 0 {
			inDelta = inTotal - prevIn
			outDelta = outTotal - prevOut
			if inDelta < 0 {
				inDelta = 0
			}
			if outDelta < 0 {
				outDelta = 0
			}
			inSpeed = float64(inDelta) / dt
			outSpeed = float64(outDelta) / dt
		}
	}
	c.lastIn[inst.ID] = inTotal
	c.lastOut[inst.ID] = outTotal
	c.lastAt[inst.ID] = now
	c.mu.Unlock()

	recorded := now.Format("2006-01-02 15:04:05.000Z")
	if err := c.store.CreateSample(ctx, map[string]any{
		"instance":        inst.ID,
		"recorded_at":     recorded,
		"in_bytes_total":  inTotal,
		"out_bytes_total": outTotal,
		"in_bytes_delta":  inDelta,
		"out_bytes_delta": outDelta,
		"in_speed_bps":    inSpeed,
		"out_speed_bps":   outSpeed,
	}); err != nil {
		log.Printf("collector: sample %s: %v", inst.Name, err)
		return
	}

	sampleCount := inst.SampleCount + 1
	inAlltime := inst.InBytesAlltime + inDelta
	outAlltime := inst.OutBytesAlltime + outDelta
	patch := map[string]any{
		"online":             true,
		"last_seen":          now.Format(time.RFC3339Nano),
		"last_error":         "",
		"in_bytes_total":     inTotal,
		"out_bytes_total":    outTotal,
		"in_bytes_alltime":   inAlltime,
		"out_bytes_alltime":  outAlltime,
		"in_speed_bps":       inSpeed,
		"out_speed_bps":      outSpeed,
		"last_sample_at":     recorded,
		"sample_count":       sampleCount,
	}
	if syncthingID != "" {
		patch["syncthing_id"] = syncthingID
	}
	if version != "" {
		patch["version"] = version
	}
	_ = c.store.PatchInstance(ctx, inst.ID, patch)
	inst.SampleCount = sampleCount

	if inDelta > 0 || outDelta > 0 {
		c.rollupHour(ctx, inst.ID, now, inDelta, outDelta)
	}
}

func (c *Collector) rollupHour(ctx context.Context, instanceID string, at time.Time, inDelta, outDelta int64) {
	bucket := at.UTC().Truncate(time.Hour).Format("2006-01-02 15:04:05.000Z")
	existing, err := c.store.FindHourly(ctx, instanceID, bucket)
	if err != nil {
		return
	}
	if existing == nil {
		_ = c.store.CreateHourly(ctx, map[string]any{
			"instance":        instanceID,
			"bucket_start":    bucket,
			"in_bytes_delta":  inDelta,
			"out_bytes_delta": outDelta,
		})
		return
	}
	_ = c.store.PatchHourly(ctx, existing.ID, map[string]any{
		"in_bytes_delta":  existing.InBytesDelta + inDelta,
		"out_bytes_delta": existing.OutBytesDelta + outDelta,
	})
}

func (c *Collector) markOffline(ctx context.Context, inst pbstore.Instance, err error) {
	msg := err.Error()
	if len(msg) > 500 {
		msg = msg[:500]
	}
	_ = c.store.PatchInstance(ctx, inst.ID, map[string]any{
		"online":     false,
		"last_error": msg,
	})
}

func (c *Collector) retentionLoop() {
	tick := time.NewTicker(6 * time.Hour)
	defer tick.Stop()
	for {
		select {
		case <-c.stopCh:
			return
		case <-tick.C:
			if c.cfg.RetentionDays <= 0 {
				continue
			}
			before := time.Now().UTC().Add(-time.Duration(c.cfg.RetentionDays) * 24 * time.Hour)
			n, err := c.store.DeleteSamplesBefore(context.Background(), before)
			if err != nil {
				log.Printf("collector: retention: %v", err)
			} else if n > 0 {
				log.Printf("collector: removed %d old transfer samples", n)
			}
			n2, err := c.store.DeleteFolderDiskSamplesBefore(context.Background(), before)
			if err != nil {
				log.Printf("collector: folder disk retention: %v", err)
			} else if n2 > 0 {
				log.Printf("collector: removed %d old folder disk samples", n2)
			}
		}
	}
}
