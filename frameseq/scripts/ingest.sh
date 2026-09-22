#!/usr/bin/env bash
# Turn one source video into a clip the harness can play: a directory of still
# images, an audio-only track, an h264 reference encode, and a manifest.
#
# The harness discovers clips by scanning for those manifests, so ingesting a
# video is the whole of "adding" one -- nothing here or in web/ lists clips by
# name, and no code changes when you add the next one.
#
# Idempotent: a clip whose manifest already exists is skipped unless --force.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=${OUT:-media}

usage() {
  cat <<'USAGE'
usage: scripts/ingest.sh <video> [options]

  <video>            any file ffmpeg can read

  --slug NAME        clip id and directory name (default: from the filename)
  --title TEXT       label in the picker (default: the filename)
  --fps N            resample to N fps (default: the source's own rate)
  --scale WxH        scale the stills, e.g. 1280x720 (default: source size)
  --seconds N        ingest only the first N seconds
  --quality N        still-image quality, passed to ffmpeg -q:v; the scale
                     depends on the encoder (webp 0-100 high-is-better,
                     mjpeg 2-31 low-is-better)
  --no-reference     skip the h264 encode used for A/B against <video>
  --force            re-ingest a clip that already exists

Frames dominate the output size: expect roughly 2-3x the source file per
minute at 1080p. Use --scale or --seconds on anything long.
USAGE
}

[ $# -ge 1 ] || { usage; exit 2; }
case "$1" in -h|--help) usage; exit 0;; esac

SRC=$1; shift
slug= title= fps= scale= seconds= quality= reference=1 force=0

while [ $# -gt 0 ]; do
  case "$1" in
    --slug) slug=$2; shift 2;;
    --title) title=$2; shift 2;;
    --fps) fps=$2; shift 2;;
    --scale) scale=$2; shift 2;;
    --seconds) seconds=$2; shift 2;;
    --quality) quality=$2; shift 2;;
    --no-reference) reference=0; shift;;
    --force) force=1; shift;;
    *) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2;;
  esac
done

[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found" >&2; exit 1; }

base=$(basename "$SRC")
stem=${base%.*}
# Slugs become both a directory name and a URL path segment, so keep them to
# characters that need no escaping in either.
[ -n "$slug" ] || slug=$(printf '%s' "$stem" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//')
[ -n "$slug" ] || { echo "could not derive a slug from $base; pass --slug" >&2; exit 1; }
[ -n "$title" ] || title=$stem

dir="$OUT/$slug"
if [ -f "$dir/clip.json" ] && [ "$force" -eq 0 ]; then
  echo "==> $slug already ingested (--force to redo)"
  exit 0
fi

say() { printf '\n==> %s\n' "$*"; }

# ------------------------------------------------------------------- probing
probe() { ffprobe -v error -select_streams "$1" -show_entries "$2" -of default=nw=1:nk=1 "$SRC" 2>/dev/null | head -1; }

src_w=$(probe v:0 stream=width)
src_h=$(probe v:0 stream=height)
src_rate=$(probe v:0 stream=r_frame_rate)   # a fraction, e.g. 24000/1001
has_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of default=nw=1:nk=1 "$SRC" 2>/dev/null | head -1)
duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$SRC" 2>/dev/null | head -1)

[ -n "$src_w" ] || { echo "$SRC has no video stream ffprobe can read" >&2; exit 1; }

# The manifest carries a decimal fps because the page's presentation clock is
# arithmetic, not a rational. 24000/1001 becomes 23.976 and the drift over a
# clip of this length is far below one frame.
src_fps=$(awk -F/ '{ printf "%.3f", ($2 ? $1/$2 : $1) }' <<<"${src_rate:-24/1}")
out_fps=${fps:-$src_fps}
# A container that reports no frame rate (some raw and image-sequence inputs)
# would otherwise write a zero into the manifest and stall the page's clock.
if ! awk -v f="$out_fps" 'BEGIN { exit (f + 0 > 0) ? 0 : 1 }'; then
  out_fps=24
  echo "note: no usable frame rate in the source; assuming 24 (--fps to override)" >&2
fi

# duration is advisory -- it only labels the picker -- but ffprobe answers "N/A"
# for streams without one, and that is not JSON.
case "$duration" in ''|*[!0-9.]*) duration=0;; esac

out_w=$src_w; out_h=$src_h
if [ -n "$scale" ]; then
  out_w=${scale%x*}; out_h=${scale#*x}
fi

# ---------------------------------------------------------------- still frames
# webp is markedly smaller at the same quality, but plenty of ffmpeg builds ship
# without it, so mjpeg is the fallback every build can do. The extension lands in
# the manifest, so the page fetches whatever was actually written.
has_encoder() { ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " $1 "; }

# Filters are a plain string, and each ffmpeg call builds its own argument array
# starting from a non-empty base: under `set -u`, bash 3.2 -- which is what
# /bin/bash is on macOS -- errors on expanding an empty array.
vf=
[ -n "$fps" ] && vf="fps=$fps"
[ -n "$scale" ] && vf="${vf:+$vf,}scale=$out_w:$out_h"

rm -rf "$dir"
mkdir -p "$dir"

if has_encoder libwebp; then
  ext=webp; enc_args=(-c:v libwebp -q:v "${quality:-80}")
else
  ext=jpg;  enc_args=(-c:v mjpeg -q:v "${quality:-3}")
fi

say "$slug: still frames (${out_w}x${out_h} @ ${out_fps}fps, $ext)"
args=(-hide_banner -loglevel error -y -i "$SRC")
[ -n "$seconds" ] && args+=(-t "$seconds")
[ -n "$vf" ] && args+=(-vf "$vf")
ffmpeg "${args[@]}" -an "${enc_args[@]}" "$dir/f%05d.$ext"

count=$(find "$dir" -name "f*.$ext" -type f | wc -l | tr -d ' ')
[ "$count" -gt 0 ] || { echo "no frames were written" >&2; exit 1; }

# ------------------------------------------------------------------- audio
# The page paints images; it has no media element to carry sound. An audio-only
# file gives it a soundtrack without reintroducing a <video>, which is the one
# thing this method exists to avoid.
audio=null
if [ -n "$has_audio" ]; then
  say "$slug: audio-only track"
  args=(-hide_banner -loglevel error -y -i "$SRC")
  [ -n "$seconds" ] && args+=(-t "$seconds")
  ffmpeg "${args[@]}" -vn -c:a aac -b:a 128k -ac 2 -movflags +faststart "$dir/audio.m4a"
  audio='"audio.m4a"'
fi

# --------------------------------------------------------------- reference mp4
# The same clip through the ordinary decode path. Without it you can measure the
# frame sequence but have nothing to compare it against, and the comparison is
# the entire question: does this client drop frames only when it is handed video?
ref=null
if [ "$reference" -eq 1 ]; then
  say "$slug: h264 reference encode"
  args=(-hide_banner -loglevel error -y -i "$SRC")
  [ -n "$seconds" ] && args+=(-t "$seconds")
  [ -n "$vf" ] && args+=(-vf "$vf")
  ffmpeg "${args[@]}" \
    -c:v libx264 -preset medium -crf 20 -profile:v high -level 4.0 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -ac 2 -movflags +faststart "$dir/reference.mp4"
  ref='"reference.mp4"'
fi

# ---------------------------------------------------------------- the manifest
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

cat > "$dir/clip.json" <<JSON
{
  "slug": "$(esc "$slug")",
  "title": "$(esc "$title")",
  "source": "$(esc "$base")",
  "pattern": "f%05d.$ext",
  "start": 1,
  "count": $count,
  "fps": $out_fps,
  "width": $out_w,
  "height": $out_h,
  "duration": ${duration:-0},
  "audio": $audio,
  "reference": $ref,
  "ingested": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

say "$slug: $count frames, $(du -sh "$dir" | cut -f1) total"
