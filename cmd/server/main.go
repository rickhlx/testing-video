// Command server hosts the video test matrix.
//
// It is a static file server with three things python -m http.server will not
// give you: Range requests (so 1080p seeking works), correct streaming MIME
// types, and optional link impairment so a client can be starved on purpose.
package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/rickhlx/testing-video/internal/mediafs"
	"github.com/rickhlx/testing-video/internal/mw"
	"github.com/rickhlx/testing-video/internal/selfsign"
)

func main() {
	var (
		addr    = flag.String("addr", defaultAddr(), "listen address; defaults to :$PORT when set, else :8080")
		webDir  = flag.String("web", "web", "directory of pages and assets")
		mediaIr = flag.String("media", "media", "directory of generated media")
		useTLS  = flag.Bool("tls", false, "serve HTTPS with a self-signed cert (needed for WebCodecs/PiP on non-localhost clients)")
		cache   = flag.Bool("cache", false, "allow client caching (off by default so repeat runs are comparable)")
		delay   = flag.Duration("delay", 0, "artificial latency added to every response, e.g. 150ms")
		kbps    = flag.Int("kbps", 0, "throughput cap in kbit/s, e.g. 3000; 0 disables")
	)
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/media/", http.StripPrefix("/media/", mediafs.Handler(*mediaIr, *cache)))
	// Same media bytes, served as application/octet-stream so nothing on the
	// wire declares them video. Pages that re-wrap the bytes client-side pull
	// from here to test a link that classifies traffic by content type or URL.
	mux.Handle("/raw/", http.StripPrefix("/raw/", mediafs.RawHandler(*mediaIr, *cache)))
	mux.Handle("/", mediafs.Handler(*webDir, *cache))
	mux.HandleFunc("/api/media", mediaIndex(*mediaIr))

	// Impairment sits inside the logger so logged durations include it.
	handler := mw.Chain(mux, mw.Log, mw.CORS, mw.Impair(*delay, *kbps))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	scheme := "http"
	if *useTLS {
		cert, err := selfsign.Cert()
		if err != nil {
			log.Fatalf("generating certificate: %v", err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		scheme = "https"
	}

	printBanner(scheme, *addr, *delay, *kbps, *useTLS)

	var err error
	if *useTLS {
		err = srv.ListenAndServeTLS("", "")
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// defaultAddr honours the PORT variable that platform hosts inject, so the same
// binary runs locally and on a PaaS without a different start command.
func defaultAddr() string {
	if p := os.Getenv("PORT"); p != "" {
		return ":" + p
	}
	return ":8080"
}

func printBanner(scheme, addr string, delay time.Duration, kbps int, useTLS bool) {
	port := addr
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		port = addr[i:]
	}
	fmt.Printf("\n  video test matrix\n\n")
	fmt.Printf("    %s://localhost%s\n", scheme, port)
	for _, ip := range selfsign.LocalIPs() {
		fmt.Printf("    %s://%s%s\n", scheme, ip, port)
	}
	if !useTLS {
		fmt.Printf("\n  note: WebCodecs, Document PiP and EME need a secure context.\n")
		fmt.Printf("        localhost is exempt; remote clients are not. Use -tls for those,\n")
		fmt.Printf("        or front this with a TLS-terminating proxy and ignore this.\n")
	}
	if delay > 0 || kbps > 0 {
		fmt.Printf("\n  impairment: delay=%s cap=%dkbps\n", delay, kbps)
	}
	fmt.Println()
}

// mediaIndex lets the landing page report what was actually generated rather
// than what the page hopes exists.
func mediaIndex(dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		type entry struct {
			Path  string `json:"path"`
			Bytes int64  `json:"bytes"`
		}
		var out []entry
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(dir, p)
			out = append(out, entry{Path: filepath.ToSlash(rel), Bytes: info.Size()})
			return nil
		})
		sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}
