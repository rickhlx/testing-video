// Package mw holds the HTTP middleware used to shape and observe requests.
//
// The impairment middleware exists because most client-side video failures are
// really network failures wearing a costume. Being able to reproduce a slow or
// high-latency link against a known-good clip separates "this client cannot
// decode" from "this client cannot buffer" -- and against a frame sequence it
// is the only way to starve the page on purpose, since there is no media stack
// underneath doing its own adaptation.
package mw

import (
	"log"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Chain applies middleware so that the first listed runs outermost.
func Chain(h http.Handler, m ...func(http.Handler) http.Handler) http.Handler {
	for i := len(m) - 1; i >= 0; i-- {
		h = m[i](h)
	}
	return h
}

// CORS keeps cross-origin fetching working when a page is served from one host
// and clips from another.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Range, Content-Type")
		// Without this the page can see the body but not the 206 metadata.
		h.Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type recorder struct {
	http.ResponseWriter
	status int
	n      int64
}

func (r *recorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.n += int64(n)
	return n, err
}

var frameExts = map[string]bool{".webp": true, ".jpg": true, ".jpeg": true, ".png": true}

// Log records the Range header explicitly: whether a client sends ranges, and
// what it asks for after a seek, is usually the first useful clue.
//
// Still frames are the exception. A clip is one request per frame, so logging
// them individually buries everything else at twenty-odd lines a second. They
// are counted instead and summarised on a fixed interval, which is the more
// useful shape anyway: what you want from a frame sequence is the fetch rate,
// not the identity of frame 1483. Pass frames=true to log them one by one.
func Log(frames bool) func(http.Handler) http.Handler {
	agg := &aggregator{interval: 5 * time.Second, since: time.Now()}
	if !frames {
		go agg.run()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &recorder{ResponseWriter: w}
			next.ServeHTTP(rec, r)

			if !frames && frameExts[strings.ToLower(path.Ext(r.URL.Path))] {
				agg.add(rec.n, rec.status)
				return
			}

			rng := r.Header.Get("Range")
			if rng == "" {
				rng = "-"
			}
			log.Printf("%-4s %d %-32s %6.1fms %9dB  range=%s", r.Method, rec.status,
				r.URL.Path, float64(time.Since(start).Microseconds())/1000, rec.n, rng)
		})
	}
}

// aggregator collapses per-frame requests into one line per interval.
type aggregator struct {
	mu       sync.Mutex
	interval time.Duration
	since    time.Time
	n        int
	bytes    int64
	errs     int
}

func (a *aggregator) add(bytes int64, status int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.n++
	a.bytes += bytes
	if status >= 400 {
		a.errs++
	}
}

// run emits one summary per interval. A ticker rather than a check inside add:
// the summary carries a rate, and a rate is only meaningful over a window of
// known length. Emitting opportunistically would print windows a few
// milliseconds wide and rates in the hundreds.
func (a *aggregator) run() {
	for range time.Tick(a.interval) {
		a.mu.Lock()
		if a.n > 0 {
			a.emitLocked()
		} else {
			a.since = time.Now() // idle: do not stretch the next window
		}
		a.mu.Unlock()
	}
}

func (a *aggregator) emitLocked() {
	elapsed := time.Since(a.since).Seconds()
	errs := ""
	if a.errs > 0 {
		errs = " errors=" + strconv.Itoa(a.errs)
	}
	log.Printf("frames  %d req  %.1f/s  %.1f MB  over %.1fs%s",
		a.n, float64(a.n)/elapsed, float64(a.bytes)/1e6, elapsed, errs)
	a.since, a.n, a.bytes, a.errs = time.Now(), 0, 0, 0
}

type pacer struct {
	http.ResponseWriter
	bytesPerSec int64
	flusher     http.Flusher
}

// Write paces the response by sleeping for however long the chunk "should"
// have taken on the target link. Coarse, but it only needs to be accurate
// enough to starve a buffer on schedule.
func (p *pacer) Write(b []byte) (int, error) {
	const chunk = 32 << 10
	total := 0
	for len(b) > 0 {
		size := min(len(b), chunk)
		n, err := p.ResponseWriter.Write(b[:size])
		total += n
		if err != nil {
			return total, err
		}
		if p.flusher != nil {
			p.flusher.Flush()
		}
		time.Sleep(time.Duration(float64(n) / float64(p.bytesPerSec) * float64(time.Second)))
		b = b[size:]
	}
	return total, nil
}

// Impair injects fixed latency before the response and caps throughput during
// it. Zero values for either disable that half.
//
// Latency bites harder here than it does on a video pipeline: a frame sequence
// pays it once per frame rather than once per multi-second segment, which is
// exactly the cost this method trades for having no media stack at all.
func Impair(delay time.Duration, kbps int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if delay <= 0 && kbps <= 0 {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if delay > 0 {
				time.Sleep(delay)
			}
			if kbps > 0 {
				f, _ := w.(http.Flusher)
				w = &pacer{ResponseWriter: w, bytesPerSec: int64(kbps) * 1000 / 8, flusher: f}
			}
			next.ServeHTTP(w, r)
		})
	}
}
