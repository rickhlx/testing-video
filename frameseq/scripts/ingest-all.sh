#!/usr/bin/env bash
# Ingest every video in sources/ that has not been ingested already.
#
# This is the bulk path: drop files into sources/, run it, reload the page.
# Per-clip options (--fps, --scale, --seconds) belong on a direct ingest.sh
# call instead; everything here takes the source's own rate and size.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=${SRC:-sources}

shopt -s nullglob nocaseglob
files=("$SRC"/*.{mp4,mov,mkv,webm,m4v,avi,ts,mpg,mpeg,y4m})
shopt -u nocaseglob

if [ ${#files[@]} -eq 0 ]; then
  echo "no videos in $SRC/ -- drop some in, or run 'make sample' for a synthetic one" >&2
  exit 1
fi

for f in "${files[@]}"; do
  ./scripts/ingest.sh "$f" "$@"
done

printf '\n==> %s clip(s) in media/\n' "$(find media -name clip.json | wc -l | tr -d ' ')"
