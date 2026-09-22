// Command server hosts the frame-sequence harness.
//
// It serves one page and whatever clips have been ingested, with the two things
// python -m http.server will not give you: correct MIME types and deliberate
// link impairment. There is no TLS flag: nothing on the page needs a secure
// context, which is the point of the method -- no WebCodecs, no MSE, no media
// element, so no secure-context requirement and no certificate to explain.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/rickhlx/frameseq/internal/catalog"
	"github.com/rickhlx/frameseq/internal/mediafs"
	"github.com/rickhlx/frameseq/internal/mw"
)

func main() {
	var (
		addr      = flag.String("addr", defaultAddr(), "listen address; defaults to :$PORT when set, else :8080")
		webDir    = flag.String("web", "web", "directory of the page and its assets")
		mediaDir  = flag.String("media", "media", "directory of ingested clips")
		cache     = flag.Bool("cache", false, "allow client caching (off by default so repeat runs are comparable)")
		delay     = flag.Duration("delay", 0, "artificial latency added to every response, e.g. 150ms")
		kbps      = flag.Int("kbps", 0, "throughput cap in kbit/s, e.g. 3000; 0 disables")
		logFrames = flag.Bool("log-frames", false, "log every still-frame request instead of a periodic summary")
	)
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/api/clips", clips(*mediaDir))
	mux.Handle("/media/", http.StripPrefix("/media/", mediafs.Handler(*mediaDir, *cache)))
	mux.Handle("/", mediafs.Handler(*webDir, *cache))

	// Impairment sits inside the logger so logged durations include it.
	handler := mw.Chain(mux, mw.Log(*logFrames), mw.CORS, mw.Impair(*delay, *kbps))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	banner(*addr, *mediaDir, *delay, *kbps)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// defaultAddr honours the PORT variable platform hosts inject, so the same
// binary runs locally and on a PaaS without a different start command.
func defaultAddr() string {
	if p := os.Getenv("PORT"); p != "" {
		return ":" + p
	}
	return ":8080"
}

// clips is rescanned per request rather than cached at startup, so a clip
// ingested while the server runs shows up on the next reload.
func clips(dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		found, err := catalog.Scan(dir)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(found)
	}
}

func banner(addr, mediaDir string, delay time.Duration, kbps int) {
	port := addr
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		port = addr[i:]
	}
	found, _ := catalog.Scan(mediaDir)

	fmt.Printf("\n  frame-sequence harness\n\n    http://localhost%s\n\n", port)
	if len(found) == 0 {
		fmt.Printf("  no clips ingested yet:\n")
		fmt.Printf("    make sample                     a synthetic clip with a burned-in indicator\n")
		fmt.Printf("    make ingest SRC=path/to.mp4     any video you have\n\n")
		return
	}
	for _, c := range found {
		fmt.Printf("    %-24s %5d frames  %gfps  %dx%d  %5.0f MB\n",
			c.Slug, c.Count, c.FPS, c.Width, c.Height, float64(c.FrameBytes)/1e6)
	}
	if delay > 0 || kbps > 0 {
		fmt.Printf("\n  impairment: delay=%s cap=%dkbps\n", delay, kbps)
	}
	fmt.Println()
}
