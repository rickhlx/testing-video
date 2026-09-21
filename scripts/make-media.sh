#!/usr/bin/env bash
# Generates the 1080p24 test media set. Idempotent: skips anything already built.
#
# Everything derives from one intermediate with a burned-in frame counter, so a
# dropped or repeated frame is visible on screen and not just a number in the
# telemetry panel.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=media
DUR=${DUR:-60}
FPS=24
mkdir -p "$OUT"/{hls,dash}

say() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------- intermediate
# One near-lossless intermediate carries the burned-in frame indicator, so every
# downstream encode shows the identical overlay and artifacts aren't compounded.
# The indicator is drawbox-only (see gen-overlay-filter.sh) because this ffmpeg
# is built without freetype and has no drawtext.
if [ ! -f "$OUT/overlay.filter" ]; then
  FPS=$FPS ./scripts/gen-overlay-filter.sh > "$OUT/overlay.filter"
fi

if [ ! -f "$OUT/source.mp4" ]; then
  say "source intermediate (${DUR}s @ ${FPS}fps 1920x1080)"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1920x1080:rate=$FPS:duration=$DUR" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$DUR" \
    -filter_script:v "$OUT/overlay.filter" \
    -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -ac 2 \
    "$OUT/source.mp4"
fi

# ------------------------------------------------------------------- h264 mp4
# Profile/level pinned so the MSE codec string is deterministic: avc1.640028.
if [ ! -f "$OUT/h264-1080p24.mp4" ]; then
  say "h264 progressive mp4"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/source.mp4" \
    -c:v libx264 -preset medium -b:v 5M -maxrate 6M -bufsize 10M \
    -profile:v high -level 4.0 -pix_fmt yuv420p -g 48 -keyint_min 48 -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 -movflags +faststart \
    "$OUT/h264-1080p24.mp4"
fi

# -------------------------------------------------------------------- vp9 webm
if [ ! -f "$OUT/vp9-1080p24.webm" ]; then
  say "vp9 webm"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/source.mp4" \
    -c:v libvpx-vp9 -b:v 4M -row-mt 1 -deadline good -cpu-used 4 \
    -g 48 -pix_fmt yuv420p -c:a libopus -b:a 128k \
    "$OUT/vp9-1080p24.webm"
fi

# --------------------------------------------------------------------- av1 mp4
if [ ! -f "$OUT/av1-1080p24.mp4" ]; then
  say "av1 mp4 (svt-av1)"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/source.mp4" \
    -c:v libsvtav1 -preset 8 -crf 34 -g 48 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -movflags +faststart \
    "$OUT/av1-1080p24.mp4"
fi

# ------------------------------------------------------- HLS (fMP4/CMAF) + MSE
# These same segments feed the hand-rolled MSE page, so it needs no demuxer.
if [ ! -f "$OUT/hls/stream.m3u8" ]; then
  say "hls fmp4 segments"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/h264-1080p24.mp4" \
    -c copy -f hls \
    -hls_time 4 -hls_playlist_type vod -hls_list_size 0 \
    -hls_segment_type fmp4 \
    -hls_fmp4_init_filename init.mp4 \
    -hls_segment_filename "$OUT/hls/seg%03d.m4s" \
    "$OUT/hls/stream.m3u8"
  cat > "$OUT/hls/master.m3u8" <<'M3U8'
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=5300000,RESOLUTION=1920x1080,FRAME-RATE=24.000,CODECS="avc1.640028,mp4a.40.2"
stream.m3u8
M3U8
fi

# Segment index for the MSE page — avoids parsing m3u8 in the browser.
if [ ! -f "$OUT/hls/index.json" ]; then
  say "mse segment index"
  {
    printf '{\n  "mimeCodec": "video/mp4; codecs=\\"avc1.640028,mp4a.40.2\\"",\n'
    printf '  "init": "init.mp4",\n  "segments": [\n'
    first=1
    for s in "$OUT"/hls/seg*.m4s; do
      [ $first -eq 1 ] || printf ',\n'
      printf '    "%s"' "$(basename "$s")"
      first=0
    done
    printf '\n  ]\n}\n'
  } > "$OUT/hls/index.json"
fi

# ------------------------------------------------------------------------ DASH
if [ ! -f "$OUT/dash/manifest.mpd" ]; then
  say "dash segments"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/h264-1080p24.mp4" \
    -c copy -f dash \
    -seg_duration 4 -use_template 1 -use_timeline 1 \
    -init_seg_name 'init-$RepresentationID$.m4s' \
    -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
    "$OUT/dash/manifest.mpd"
fi

say "done"
ls -lh "$OUT" | tail -n +2
printf '\nhls: %s segments\ndash: %s segments\n' \
  "$(ls "$OUT"/hls/seg*.m4s 2>/dev/null | wc -l | tr -d ' ')" \
  "$(ls "$OUT"/dash/chunk-*.m4s 2>/dev/null | wc -l | tr -d ' ')"
