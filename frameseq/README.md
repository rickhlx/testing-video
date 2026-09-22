# frameseq

Page 14 of the video matrix, pulled out on its own and pointed at whatever
videos you want to test.

The method: play a clip as individual still images blitted to a canvas on a
fixed clock. No `<video>`, no `VideoDecoder`, no MSE — nothing on the page is a
media element, so a frame-drop control that hooks the recognised media pipeline
has nothing to hook. If a client holds rate on the stills but drops frames on
the same clip through `<video>`, the frames are being taken inside that
pipeline rather than on the link or in raw decode.

In the matrix that question was asked of one synthetic clip. Here it is asked of
any clip, because which content a control reacts to is itself a variable.

## Quickstart

```
make sample            # synthetic clip with a burned-in frame indicator
make run               # serve on :8080
```

Then add your own:

```
make ingest SRC=~/Downloads/some-clip.mp4
```

Reload the page. The new clip is in the picker. See
[How to add a video](#how-to-add-a-video) for the options that matter on long
or large sources.

## How to add a video

Adding a clip is an ingest, not a code change. Nothing in `web/` or `cmd/`
knows any clip by name, so there is no list to edit and no rebuild to do.

### 1. Ingest it

Point the script at any file ffmpeg can read. It works out the resolution,
frame rate and duration for itself.

```
make ingest SRC=~/Downloads/product-demo.mp4
```

```
==> product-demo: still frames (1920x1080 @ 29.970fps, jpg)
==> product-demo: audio-only track
==> product-demo: h264 reference encode
==> product-demo: 900 frames, 114M total
```

That writes `media/product-demo/`: one image per frame, an `audio.m4a` for the
soundtrack, a `reference.mp4` for the A/B against `<video>`, and a `clip.json`
manifest. The slug comes from the filename.

**Long or large sources should be trimmed on the way in.** Stills are the cost
of having no codec — see [Size](#size) below, but the short version is that a
full-length 1080p source will produce a clip nobody wants to pull over a real
link.

```
make ingest SRC=~/Downloads/keynote.mov ARGS='--seconds 30 --scale 1280x720'
```

### 2. Check it landed

```
make clips
```

```
SLUG                    FRAMES    FPS        SIZE REFERENCE  TITLE
bars-720p30                150 30.000        1.9M       yes  SMPTE bars 720p30
indicator                  144 24.000         20M       yes  Indicator 24fps (synthetic)
product-demo               900 29.970        114M       yes  product-demo
```

### 3. Select it

Reload the page. The clip is in the picker, sorted by title. The server rescans
`media/` on every request, so a clip ingested against a running server needs no
restart.

To go straight to it, or to hand one specific comparison to a fleet:

```
http://localhost:8080/?clip=product-demo&mode=frames
http://localhost:8080/?clip=product-demo&mode=reference
```

### Adding several at once

```
cp ~/Videos/*.mp4 sources/
make ingest-all
```

`ingest-all` skips anything already ingested, so it is safe to re-run after
dropping in one more file. It takes no per-clip options — a clip that needs
`--scale` or `--seconds` gets its own `make ingest` call.

`sources/` is gitignored, so what you put there stays local. It is also the
directory the Docker build ingests from, which is how your clips reach a
deployment.

### Changing a clip

Ingesting a slug that already exists is a no-op:

```
==> product-demo already ingested (--force to redo)
```

Re-ingest with different options by adding `--force`, which replaces the clip
directory:

```
./scripts/ingest.sh ~/Downloads/product-demo.mp4 --force --scale 1280x720
```

Options:

| Option | Effect |
|--------|--------|
| `--slug NAME` | Clip id and directory name. Defaults to the filename. |
| `--title TEXT` | Label in the picker. Defaults to the filename. |
| `--fps N` | Resample. Default is the source's own rate. |
| `--scale WxH` | Scale the stills. Default is the source's size. |
| `--seconds N` | Ingest only the first N seconds. |
| `--quality N` | Passed to ffmpeg `-q:v`. Scale depends on the encoder: webp is 0-100 and higher is better, mjpeg is 2-31 and lower is better. |
| `--no-reference` | Skip the h264 encode. There is then nothing to compare against, so keep it unless you are tight on space. |
| `--force` | Re-ingest a clip that already exists. |

Remove one clip with `rm -rf media/<slug>`, or all of them with
`make distclean`.

### When it does not work

**`<file> has no video stream ffprobe can read`** — the source is audio-only or
a container ffprobe cannot open. Nothing is written; an existing clip of the
same slug is left alone.

**`note: no usable frame rate in the source; assuming 24`** — some raw and
image-sequence inputs carry no rate. Pass `--fps` with the real one, or the
presentation clock will run the clip fast or slow.

**Two sources with the same filename collide** — the slug comes from the
filename, so `a/clip.mp4` and `b/clip.mp4` both want `media/clip`. The second
is refused as already ingested. Pass `--slug` to separate them.

**Frames came out as `.jpg` and are larger than expected** — the local ffmpeg
has no `libwebp`, so mjpeg was used, which is roughly 3x the size at similar
quality. The manifest records which was written, so the page still works; it is
only a size difference.

### Size

Stills are the cost of having no codec: expect roughly 2-3x the source file per
minute at 1080p, and one HTTP request per frame. A 60-second 1080p clip lands
around 150 MB. `--scale` and `--seconds` are the knobs; use them on anything
long before handing the URL to a fleet.

webp is used when the local ffmpeg has `libwebp` and mjpeg otherwise, which is
roughly a 3x size difference. The manifest records which, so the page fetches
whatever was written.

## Reading a run

Both modes report the same numbers computed the same way, which is the point —
they are meant to be compared against each other, not read in isolation.

- **frames** — the method under test. `painted fps` against the clip's own rate,
  `frames skipped` for what the clock passed over.
- **reference `<video>`** — the same clip through the ordinary decode path.
  `presented fps` and `frames dropped` come from the browser's own counters.

Read `buffered ahead` before reading a low rate as a client problem. A frame
sequence starves in a way a video pipeline does not: it pays the link's latency
once per frame instead of once per segment, so a slow or high-latency link shows
up as skipped frames that have nothing to do with the client's decoding.

`?clip=<slug>&mode=frames|reference` selects a run from the URL, so a particular
comparison can be handed to a fleet as one link.

The synthetic clip from `make sample` carries a burned-in frame indicator, so a
drop is visible on the screen of a client you cannot attach a debugger to: a
white marker stepping one slot per frame, green blocks counting the frame number
in binary, a red box blinking twice a second. Real content tells you whether a
client copes with your material; keep that one alongside it to find out exactly
which frames were lost.

## Server

| Flag | Effect |
|------|--------|
| `-addr` | Listen address, default `:8080`, or `:$PORT` when set |
| `-cache` | Allow client caching; off by default so repeat runs are comparable |
| `-delay` | Add fixed latency to every response, e.g. `-delay 150ms` |
| `-kbps` | Cap throughput, e.g. `-kbps 3000` |
| `-log-frames` | Log every frame request instead of a summary every 5s |

Impairment is how you starve the page on purpose. There is no media stack
underneath doing its own adaptation, so what the flags do to the link is exactly
what the telemetry shows.

```
make run ARGS='-delay 150ms -kbps 3000'
```

There is no `-tls` flag, unlike the parent matrix. Nothing here needs a secure
context, which is a consequence of the method rather than an omission.

Request logs carry the `Range` header. Frame requests are summarised rather than
logged individually — at one request per frame they would bury everything else.

## Deploying

The `Dockerfile` ingests clips, compiles the server, and assembles a distroless
image with the binary, `web/` and `media/`. Anything sitting in `sources/` at
build time is ingested into the image, so a local `docker build` carries your
clips; a clone carries only the synthetic one.

For Railway, set the service's root directory to `frameseq/` and it picks up
`railway.toml`. The server reads `PORT`, so no start command is needed, and
`/healthz` is wired up as the healthcheck.

```
docker build -t frameseq .                  # sample clip only
docker build --build-arg SAMPLE=0 -t frameseq .   # only what is in sources/
```

Egress is the thing to watch: one sweep of a 60-second 1080p clip is ~150 MB in
frames mode alone.

## Layout

```
cmd/server/         wiring and flags
internal/catalog/   scans media/ for clip manifests
internal/mediafs/   static serving and MIME types
internal/mw/        logging and link impairment
scripts/ingest.sh   one video -> frames, audio, reference, manifest
scripts/list-clips.sh   what has been ingested, without starting the server
web/assets/player.js    the frame-sequence player
web/assets/telemetry.js measurement shared by both modes
media/              ingested clips, generated
sources/            drop videos here
```

This directory is a self-contained Go module with no dependencies outside the
standard library. Moving it into its own repository is a `git mv` and nothing
else.
