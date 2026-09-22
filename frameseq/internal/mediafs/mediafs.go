// Package mediafs serves static files with the MIME types a media client needs.
// Go's default type table misses several of these, and a Chromium client handed
// the wrong type fails in ways that look like a decode problem rather than a
// header problem.
package mediafs

import (
	"mime"
	"net/http"
	"path/filepath"
)

// Types are registered explicitly rather than trusting the host's mime.types,
// so behaviour is identical on a dev laptop and in a container.
var types = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
	".m4a":  "audio/mp4",
	".webp": "image/webp",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".js":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8",
}

func init() {
	for ext, typ := range types {
		_ = mime.AddExtensionType(ext, typ)
	}
}

// Handler serves dir. Range requests come free via http.ServeContent inside
// http.FileServer, which is why this is Go and not python -m http.server: the
// reference encode is seekable only with 206 responses.
func Handler(dir string, cache bool) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if typ, ok := types[filepath.Ext(r.URL.Path)]; ok {
			w.Header().Set("Content-Type", typ)
		}
		setCache(w, cache)
		fs.ServeHTTP(w, r)
	})
}

func setCache(w http.ResponseWriter, cache bool) {
	if cache {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	} else {
		// Default off: a cached frame makes the next measurement a lie, and a
		// clip is thousands of small cacheable files.
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	}
}
