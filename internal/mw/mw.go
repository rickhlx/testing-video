// Package mw holds the HTTP middleware used to shape and observe requests.
//
// The impairment middleware exists because most client-side video failures are
// really network failures wearing a costume. Being able to reproduce a slow or
// high-latency link against a known-good file separates "this client cannot
// decode" from "this client cannot buffer".
package mw

import (
	"log"
	"net/http"
	"time"
)

// Chain applies middleware so that the first listed runs outermost.
func Chain(h http.Handler, m ...func(http.Handler) http.Handler) http.Handler {
	for i := len(m) - 1; i >= 0; i-- {
		h = m[i](h)
	}
	return h
}

// CORS keeps cross-origin embedding and fetch-based pipelines (MSE, WebCodecs)
// working when a page is served from one host and media from another.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Range, Content-Type")
		// Without this the player can see the body but not the 206 metadata.
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

// Log records the Range header explicitly: whether a client sends ranges, and
// what it asks for after a seek, is usually the first useful clue.
func Log(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &recorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		rng := r.Header.Get("Range")
		if rng == "" {
			rng = "-"
		}
		log.Printf("%-3s %d %-9s %6.1fms %8dB  range=%s", r.Method, rec.status,
			r.URL.Path, float64(time.Since(start).Microseconds())/1000, rec.n, rng)
	})
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
