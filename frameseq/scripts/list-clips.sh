#!/usr/bin/env bash
# One line per ingested clip: what the picker will show, without starting the
# server.
#
# The manifests are written by ingest.sh with one field per line, so reading
# them line by line is enough and keeps this free of a JSON dependency. The
# server parses them properly; this is for the terminal.
set -euo pipefail

cd "$(dirname "$0")/.."

shopt -s nullglob
files=(media/*/clip.json)

if [ ${#files[@]} -eq 0 ]; then
  echo "nothing ingested yet -- try 'make sample', or 'make ingest SRC=path/to.mp4'"
  exit 0
fi

field() { grep "\"$2\":" "$1" | head -1 | sed 's/.*: *//; s/,$//; s/^"//; s/"$//'; }

printf '%-22s %7s %6s %11s %9s  %s\n' SLUG FRAMES FPS SIZE REFERENCE TITLE
for f in "${files[@]}"; do
  ref=$(field "$f" reference)
  [ "$ref" = null ] && ref=no || ref=yes
  printf '%-22s %7s %6s %11s %9s  %s\n' \
    "$(field "$f" slug)" \
    "$(field "$f" count)" \
    "$(field "$f" fps)" \
    "$(du -sh "$(dirname "$f")" | cut -f1 | tr -d ' ')" \
    "$ref" \
    "$(field "$f" title)"
done
