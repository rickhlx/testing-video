#!/usr/bin/env bash
# Write a synthetic reference clip into sources/ and ingest it.
#
# It carries a burned-in frame indicator, so a dropped frame is visible on the
# screen of a client you cannot attach a debugger to -- which is the whole
# reason to keep one known clip alongside whatever real videos you are testing.
# Real content tells you whether a client copes with your material; this one
# tells you exactly which frames it lost.
set -euo pipefail

cd "$(dirname "$0")/.."
DUR=${DUR:-30}
FPS=${FPS:-24}
SRC=sources/indicator-${FPS}fps.mp4

mkdir -p sources media

if [ ! -f "$SRC" ]; then
  # The indicator is drawbox-only (see gen-overlay-filter.sh), so this works on
  # an ffmpeg built without freetype, where drawtext does not exist.
  printf '\n==> synthetic indicator clip (%ss @ %sfps 1920x1080)\n' "$DUR" "$FPS"
  FPS=$FPS ./scripts/gen-overlay-filter.sh > media/overlay.filter
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=1920x1080:rate=$FPS:duration=$DUR" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=$DUR" \
    -filter_script:v media/overlay.filter \
    -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -ac 2 \
    "$SRC"
fi

./scripts/ingest.sh "$SRC" --slug indicator --title "Indicator ${FPS}fps (synthetic)" "$@"
