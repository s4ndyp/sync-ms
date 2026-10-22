package main

import (
	"log"

	"github.com/s4ndyp/sync-ms/internal/diskprobe"
)

func main() {
	if err := diskprobe.Run(); err != nil {
		log.Fatal(err)
	}
}
