package main

import (
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/s4ndyp/sync-ms/internal/collector"
)

func main() {
	pbURL := envOr("SYNCMS_PB_URL", "http://127.0.0.1:8090")
	sampleSec := envIntOr("SYNCMS_SAMPLE_INTERVAL_SEC", 60)
	rollupEvery := envIntOr("SYNCMS_ROLLUP_EVERY_SAMPLES", 60)
	retentionDays := envIntOr("SYNCMS_RETENTION_DAYS", 45)

	c := collector.New(collector.Config{
		PocketBaseURL:      pbURL,
		SampleIntervalSec:  sampleSec,
		RollupEverySamples: rollupEvery,
		RetentionDays:      retentionDays,
	})

	go c.Run()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Println("collector: shutdown")
	c.Stop()
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envIntOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		n, err := strconv.Atoi(v)
		if err == nil && n > 0 {
			return n
		}
	}
	return def
}
