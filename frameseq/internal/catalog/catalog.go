// Package catalog reads the clip manifests that scripts/ingest.sh writes.
//
// Adding a clip is ingesting one: the catalog is whatever is on disk, scanned
// per request, so a clip ingested while the server is running appears on the
// next page load without a restart.
package catalog

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// Clip is one ingested video. The fields the page needs to run the presentation
// clock are exactly the ones ingest.sh measures from the source, so a clip plays
// at its own rate and size rather than an assumed 1080p24.
type Clip struct {
	Slug      string  `json:"slug"`
	Title     string  `json:"title"`
	Source    string  `json:"source"`
	Pattern   string  `json:"pattern"`
	Start     int     `json:"start"`
	Count     int     `json:"count"`
	FPS       float64 `json:"fps"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Duration  float64 `json:"duration"`
	Audio     *string `json:"audio"`
	Reference *string `json:"reference"`
	Ingested  string  `json:"ingested"`

	// FrameBytes is the size of the still images alone, filled in by the scan.
	// It is what a client pulls to play the clip this way, it is the number
	// that decides whether a clip is usable over a given link, and it is not
	// knowable from the manifest. Bytes covers the whole clip directory.
	FrameBytes int64 `json:"frameBytes"`
	Bytes      int64 `json:"bytes"`
}

// Scan returns every clip under dir, ordered by title so the picker is stable
// across reloads. A manifest that will not parse is skipped rather than
// failing the whole catalog: one bad ingest should not hide the others.
func Scan(dir string) ([]Clip, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Clip{}, nil
		}
		return nil, err
	}

	clips := make([]Clip, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		clip, err := read(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		clips = append(clips, clip)
	}

	sort.Slice(clips, func(i, j int) bool { return clips[i].Title < clips[j].Title })
	return clips, nil
}

func read(dir string) (Clip, error) {
	var c Clip
	b, err := os.ReadFile(filepath.Join(dir, "clip.json"))
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	// Trust the directory name over the manifest's own slug: the directory is
	// what the URLs are built from, and a hand-edited manifest could disagree.
	c.Slug = filepath.Base(dir)
	c.FrameBytes, c.Bytes = sizes(dir, filepath.Ext(c.Pattern))
	return c, nil
}

// sizes returns the bytes held by the still images and by the directory as a
// whole. frameExt comes from the manifest's pattern, since which image format
// was written depends on the ffmpeg that did the ingest.
func sizes(dir, frameExt string) (frames, total int64) {
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		total += info.Size()
		if filepath.Ext(d.Name()) == frameExt {
			frames += info.Size()
		}
		return nil
	})
	return frames, total
}
