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
| 13 | Disguised bytes into `<video>` | A link that classifies traffic by type, not by decode |
| 14 | Still-frame sequence on canvas | Whether anything downstream of decode is even a video |

Excluded deliberately, because none of them carries 1080p24: animated GIF, APNG,
animated WebP, animated AVIF, MJPEG in `<img>`, SVG `foreignObject`, and data
URIs.

## Red-team paths

Pages 13 and 14 exist to answer a different question than the diagnostic dozen:
if something upstream drops frames on purpose when it recognises video, where
does that recognition actually live? They carry the same clip and the same
burned-in indicator, so a bypass is visible and counted exactly as everywhere
else, and each probes one place the recognition could sit.

- **13 disguises the bytes on the wire.** It is the same H.264 file as page 01,
  but pulled from `/raw`, which answers `application/octet-stream` with no media
  extension in the URL. Only once the whole body is in memory is it re-declared
  `video/mp4` as a Blob and handed to a `<video>`. It still uses the native
  decode path, so anything reading the decoded pipeline still bites here; a
  difference from page 01 instead points at something classifying the *traffic*
  by URL, MIME or response shape.
- **14 removes the video pipeline entirely.** The clip is served as individual
  still images and blitted to a canvas on a 24fps clock. There is no `<video>`,
  no `VideoDecoder` and no MSE on the page, so a control that hooks the
  recognised media pipeline has nothing to hook. If this holds 24 while the
  video pages drop, the frames are being taken inside that pipeline. Fetching
  runs on its own timer, decoupled from the paint clock, so a slow link starves
  the buffer honestly rather than the throttled rAF starving it artificially.

`/raw` serves the same files as `/media` with the same range support, only ever
labelled `application/octet-stream`. The still frames are generated alongside the
rest of the media (webp where ffmpeg has it, mjpeg otherwise) and add roughly
their own clip's worth of egress — about 150 MB at the default 60s, so lower
`DUR` if that matters for a fleet.

### Testing page 14 against your own videos

Page 14 carries the one synthetic clip, like every other page here, because the
matrix compares mechanisms and holding the content constant is what makes that
comparison mean anything. Which content a frame-drop control reacts to is a
different question, and it needs the opposite setup: one mechanism, many clips.

`frameseq/` is that setup — page 14's method extracted into a self-contained
harness with a clip picker, an ingest script for adding videos, and the same
clip through an ordinary `<video>` alongside it as a control. See
[`frameseq/README.md`](frameseq/README.md).

```
cd frameseq && make sample && make run
make ingest SRC=path/to/your-video.mp4
```

Adding a clip there is an ingest, not a code change; the walkthrough is under
[How to add a video](frameseq/README.md#how-to-add-a-video).

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

## Deploying to Railway

Hosting this somewhere public is the most useful thing you can do with it: you
point any client at one URL instead of getting a laptop onto the same network as
each one. Railway terminates TLS at its edge, so the pages that need a secure
context (10 WebCodecs, 12 Document PiP) work on remote clients against a real
certificate, with no self-signed cert and no `-tls`.

```
railway up             # build and deploy from this directory
railway logs           # request log, including the Range header
railway domain         # get or create the public URL
```

The build is the `Dockerfile`, in three stages: generate media with ffmpeg,
compile the server, then assemble a distroless image with the binary, `web/` and
`media/`. Nothing is committed that the build can produce.

The server reads `PORT`, which Railway injects, so no start command is needed.
`/healthz` is wired up as the healthcheck.

### Things worth knowing

**First build takes several minutes,** because it generates the media. After
that the media stage is cached and only rebuilds when `scripts/` changes, so
code edits deploy quickly.

**The image carries about 166 MB of media** at the default 60-second clip. To
trade fidelity for size and egress, lower it:

```
railway variables --set DUR=20      # then redeploy; ~55 MB instead
```

`DUR` is a Docker `ARG`, so it only takes effect on a rebuild, and it changes
clip length only — the frame indicator, codecs and bitrates are unchanged, so
results stay comparable with a local run at the same `DUR`.

**Egress is small but not zero.** A client working through all twelve pages pulls
roughly 400-500 MB. That is cents per sweep, but it is worth knowing before you
hand the URL to a fleet.

**Impairment still works** via a custom start command, though over the public
internet you already have real variance to contend with:

```
./server -delay 150ms -kbps 3000
```

**AV1 may be absent.** The media script picks whichever AV1 encoder the local
ffmpeg has, preferring SVT-AV1 and falling back to libaom. If Debian's ffmpeg has
neither, the build logs `av1 mp4 SKIPPED` and continues; the AV1 entry in page
01's codec menu will then 404, which the telemetry panel reports as
`MEDIA_ERR_SRC_NOT_SUPPORTED`. Everything else is unaffected.

**Caching.** The server sends `no-store` by default so repeat runs are
comparable. If a client stalls against the deployment but plays media from
elsewhere, redeploy with `-cache` in the start command: Chromium's media stack
leans on the HTTP cache for range-based playback.

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
frameseq/           page 14's method as a standalone multi-clip harness
```

`frameseq/` is its own Go module and deploys separately; it is here for
proximity, not because it shares code.

Libraries are vendored rather than pulled from a CDN so the matrix works on an
isolated lab network.
