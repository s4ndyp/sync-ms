//go:build windows

package disk

import "errors"

func Usage(path string) (freeBytes, totalBytes uint64, err error) {
	return 0, 0, errors.New("disk usage not supported on windows build")
}
