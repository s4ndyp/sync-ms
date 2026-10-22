//go:build !windows

package disk

import (
	"golang.org/x/sys/unix"
)

func Usage(path string) (freeBytes, totalBytes uint64, err error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bsize := uint64(st.Bsize)
	freeBytes = uint64(st.Bavail) * bsize
	totalBytes = uint64(st.Blocks) * bsize
	return freeBytes, totalBytes, nil
}
