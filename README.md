# testing-video

Twelve ways of putting the same 1080p24 clip on screen, each isolating a
different layer of the pipeline, so that a misbehaving Chromium client can be
narrowed down to a cause rather than a symptom.

Every page reports identical telemetry, which is the point: pages are meant to
be compared against each other, not read in isolation.

## Quickstart

```
make run              # generates media on first run, then serves on :8080
make tls              # same, over HTTPS with a self-signed cert
```

Media generation takes a few minutes the first time and is skipped thereafter.
It needs `ffmpeg` with `libx264`, `libvpx-vp9` and `libsvtav1`.

## The matrix

| # | Page | Isolates |
|---|------|----------|
| 01 | `<video>` progressive MP4 | Baseline: range requests and the native decode path |
| 02 | `<video>` from Blob URL | The same decode path with the network removed |
| 03 | MSE + hand-appended fMP4 | Whether MSE itself is healthy, under any library |
| 04 | HLS via hls.js | The common production path |
| 05 | Native HLS | Splits Chrome-on-Android and WebView from desktop |
| 06 | DASH via shaka-player | The other production path, different buffering policy |
| 07 | Canvas 2D `drawImage` | A per-frame pixel copy on the main thread |
| 08 | OffscreenCanvas in a Worker | The same copy, off the main thread |
| 09 | WebGL texture upload | Video as a GL texture |
| 10 | WebCodecs `VideoDecoder` | The decoder with no `<video>` element at all |
| 11 | CSS-composited video | Effects that force video off the hardware overlay |
| 12 | Picture-in-Picture | A separate compositing surface |

Excluded deliberately, because none of them carries 1080p24: animated GIF, APNG,
animated WebP, animated AVIF, MJPEG in `<img>`, SVG `foreignObject`, and data
URIs.

## How to run an investigation

Work down the list. The first page that misbehaves names the layer.

- **01 bad** — the client cannot decode 1080p24 at all. Nothing below helps.
- **01 bad, 02 good** — decode is fine; the problem is the link or the server.
- **03 good, 04/06 bad** — MSE is fine; the player library's buffering is not.
- **01 good, 07 bad** — the client cannot afford a per-frame copy. Compare 08 and
  09 to find out whether the main thread or the copy itself is the constraint.
- **01 good, 11 bad** — a CSS effect is dragging the video off the hardware
  overlay. Toggle them one at a time to find which.

## Reading the picture

The clip carries a burned-in indicator so drops are visible, not merely counted.
It is drawn entirely with `drawbox` primitives, so it needs no font and survives
an ffmpeg built without freetype.

- **White marker** steps one slot per frame and wraps once per second. A smooth
  sweep is healthy; a skipped slot is a dropped frame.
- **Green blocks** are the frame number in binary, most significant bit at the
  left, covering 2048 frames. This is readable from a photograph of a client you
  cannot attach a debugger to.
- **Red box** blinks twice a second as a peripheral cadence check.

## Server

A static file server with the three things `python -m http.server` will not give
you: HTTP range requests, correct streaming MIME types, and deliberate link
impairment.

| Flag | Effect |
|------|--------|
| `-addr` | Listen address, default `:8080` |
| `-tls` | Self-signed HTTPS covering localhost and this host's LAN addresses |
| `-cache` | Allow client caching; off by default so repeat runs are comparable |
| `-delay` | Add fixed latency to every response, e.g. `-delay 150ms` |
| `-kbps` | Cap throughput, e.g. `-kbps 3000` |

`-tls` is not optional for remote clients. WebCodecs (page 10) and Document PiP
(page 12) require a secure context; `localhost` is exempt but a client reaching
this host by IP over plain HTTP is not, and those pages will report the feature
as missing rather than explaining why.

If a client plays media from other servers but stalls against this one, try
`-cache` first: Chromium's media stack leans on the HTTP cache for range-based
playback, and `no-store` is the more aggressive default this server ships with.

Request logs include the `Range` header, which is usually the first useful clue
after a seek.

## Layout

```
cmd/server/         wiring and flags
internal/mediafs/   static serving and MIME types
internal/mw/        logging, CORS, and link impairment
internal/selfsign/  throwaway TLS certificate
scripts/            media generation
web/pages/          the twelve pages
web/assets/         shared telemetry, scaffold and styling
web/vendor/         hls.js, shaka-player, mp4box.js, vendored for offline labs
```

Libraries are vendored rather than pulled from a CDN so the matrix works on an
isolated lab network.
