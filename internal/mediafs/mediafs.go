// Package mediafs serves static files with the MIME types streaming clients
// need. Go's default type table gets several of these wrong or misses them
// entirely, and a Chromium client handed the wrong type for an .m3u8 or .m4s
// fails in ways that look like a decode problem rather than a header problem.
package mediafs

import (
	"mime"
	"net/http"
	"path/filepath"
)

// types are registered explicitly rather than trusting the host's mime.types,
// so behaviour is identical on a dev laptop and in a container.
var types = map[string]string{
	".m3u8": "application/vnd.apple.mpegurl",
	".mpd":  "application/dash+xml",
	".m4s":  "video/iso.segment",
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".webm": "video/webm",
	".ts":   "video/mp2t",
	".vtt":  "text/vtt",
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
// http.FileServer, which is the whole reason this is Go and not python -m
// http.server: seeking a 1080p file needs 206 responses.
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

// RawHandler serves the same bytes as Handler but labels every response
// application/octet-stream, no matter the extension. It exists so a client can
// pull a media file without the wire ever announcing it as video: same range
// support, same file, a content type that says nothing. The client is expected
// to re-wrap the bytes (a typed Blob, WebCodecs, MSE) once they arrive.
func RawHandler(dir string, cache bool) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		setCache(w, cache)
		fs.ServeHTTP(w, r)
	})
}

func setCache(w http.ResponseWriter, cache bool) {
	if cache {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	} else {
		// Default off: a cached segment makes the next measurement a lie.
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	}
}
