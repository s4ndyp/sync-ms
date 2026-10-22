package disk

import (
	"os"
	"path/filepath"
	"strings"
)

func ExpandPath(path, home string) string {
	p := strings.TrimSpace(path)
	if p == "" {
		return p
	}
	if p == "~" {
		if home == "" {
			return p
		}
		return home
	}
	if strings.HasPrefix(p, "~/") {
		if home == "" {
			return p
		}
		return filepath.Join(home, p[2:])
	}
	return p
}

func ResolveExistingPath(path, home string) (string, error) {
	expanded := ExpandPath(path, home)
	if expanded == "" || expanded == "~" {
		return "", os.ErrNotExist
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return abs, nil
	}
	return filepath.Dir(abs), nil
}
