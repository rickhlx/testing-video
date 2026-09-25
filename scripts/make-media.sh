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
# Which AV1 encoder exists depends entirely on how ffmpeg was built: Homebrew
# ships SVT-AV1, Debian ships libaom. Pick whichever is here rather than making
# the build depend on a particular ffmpeg.
has_encoder() { ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " $1 "; }

if [ ! -f "$OUT/av1-1080p24.mp4" ]; then
  if has_encoder libsvtav1; then
    say "av1 mp4 (svt-av1)"
    av1_args="-c:v libsvtav1 -preset 8 -crf 34"
  elif has_encoder libaom-av1; then
    # libaom is markedly slower, so the speed knob is pushed further.
    say "av1 mp4 (libaom)"
    av1_args="-c:v libaom-av1 -crf 34 -b:v 0 -cpu-used 8 -row-mt 1"
  else
    say "av1 mp4 SKIPPED: this ffmpeg has neither libsvtav1 nor libaom-av1"
    av1_args=""
  fi

  if [ -n "$av1_args" ]; then
    # shellcheck disable=SC2086
    ffmpeg -hide_banner -loglevel error -y -i "$OUT/source.mp4" \
      $av1_args -g 48 -pix_fmt yuv420p \
      -c:a aac -b:a 128k -movflags +faststart \
      "$OUT/av1-1080p24.mp4"
  fi
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

# -------------------------------------------------- still-frame sequence
# The same 1080p24 clip as individual still images. A client that blits these
# to a canvas on a 24fps clock reproduces the picture without ever creating a
# <video>, a decoder or an MSE buffer, so a frame-drop control that engages on
# the recognised video pipeline has nothing to engage on. Prefer webp for size;
# fall back to mjpeg, which every ffmpeg build carries. Extension is recorded in
# the manifest so the page fetches whatever was actually written.
if [ ! -f "$OUT/frames/index.json" ]; then
  mkdir -p "$OUT/frames"
  if has_encoder libwebp; then
    say "still-frame sequence (webp)"
    ext=webp; frame_args="-c:v libwebp -q:v 80"
  else
    say "still-frame sequence (mjpeg)"
    ext=jpg; frame_args="-c:v mjpeg -q:v 3"
  fi
  # shellcheck disable=SC2086
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/source.mp4" \
    -an $frame_args "$OUT/frames/f%05d.$ext"
  count=$(ls "$OUT"/frames/f*."$ext" | wc -l | tr -d ' ')
  cat > "$OUT/frames/index.json" <<JSON
{
  "pattern": "f%05d.$ext",
  "start": 1,
  "count": $count,
  "fps": $FPS,
  "width": 1920,
  "height": 1080
}
JSON
fi

# ------------------------------------------------------------ audio-only track
# The still-frame page (14) has no <video>, so it carries no sound of its own.
# A small audio-only file lets it play the same 440Hz tone as the rest of the
# matrix without pulling a whole video down just for the track.
if [ ! -f "$OUT/audio.m4a" ]; then
  say "audio-only track"
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/source.mp4" \
    -vn -c:a aac -b:a 128k -movflags +faststart "$OUT/audio.m4a"
fi

# ---------------------------------------------------------- scrambled h264 blob
# The same H.264 bytes as h264-1080p24.mp4, XORed with a constant so nothing on
# the wire matches an MP4 or H.264 signature -- no ftyp box, no NAL start codes,
# no readable atom tree. Page 15 pulls this from /raw (octet-stream) and XORs it
# back before demuxing, so a control that classifies traffic by inspecting the
# payload for a video signature, not just its MIME or URL, has nothing to match.
#
# The key is a single byte: this is about defeating content *recognition*, not
# providing confidentiality, and single-byte XOR is the cheapest transform that
# still leaves zero container structure visible on the wire. perl (perl-base is
# present on Debian and macOS) does the whole-file XOR; the .bin extension keeps
# the server's MIME table from ever typing it as media even outside /raw.
if [ ! -f "$OUT/h264-scrambled.bin" ] && [ -f "$OUT/h264-1080p24.mp4" ]; then
  say "scrambled h264 blob (xor 0x5a)"
  perl -0777 -ne 'print pack("C*", map { $_ ^ 0x5a } unpack("C*", $_))' \
    < "$OUT/h264-1080p24.mp4" > "$OUT/h264-scrambled.bin"
fi

say "done"
ls -lh "$OUT" | tail -n +2
printf '\nhls: %s segments\ndash: %s segments\n' \
  "$(ls "$OUT"/hls/seg*.m4s 2>/dev/null | wc -l | tr -d ' ')" \
  "$(ls "$OUT"/dash/chunk-*.m4s 2>/dev/null | wc -l | tr -d ' ')"
