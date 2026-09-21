#!/usr/bin/env bash
# Emits an ffmpeg filter chain that burns a font-free frame indicator into the
# bottom of the frame. This ffmpeg has no freetype, so drawtext is unavailable;
# everything here is drawbox.
#
# drawbox evaluates its geometry once at filter-init, so nothing can move via an
# x= expression. Only `enable` is re-evaluated per frame, so anything animated
# is built as a set of static boxes gated on the frame number `n`.
#
# Three indicators, all readable without a font:
#   blink box (top left)   0.5s on / 0.5s off, peripheral cadence check
#   phase track (24 slots) marker advances one slot per frame, wraps each
#                          second; a dropped frame shows as a skipped slot
#   binary counter (11bit) exact frame number, MSB leftmost, covers 2048 frames
set -euo pipefail

FPS=${FPS:-24}
BITS=${BITS:-11}
SLOT=$(( 1920 / FPS ))

f=""
add() { f="${f:+$f,}$1"; }

# Dim band so indicators stay legible over any picture content.
add "drawbox=x=0:y=ih-170:w=iw:h=170:color=black@0.85:t=fill"

# Cadence blink.
add "drawbox=x=40:y=40:w=150:h=150:color=red@0.9:t=fill:enable='lt(mod(n\,$FPS)\,$((FPS/2)))'"

# Empty phase-track slots, so the track reads as a scale even when unlit.
for s in $(seq 0 $(( FPS - 1 )) ); do
  add "drawbox=x=$(( s * SLOT + 2 )):y=ih-160:w=$(( SLOT - 4 )):h=70:color=gray@0.25:t=fill"
done

# Quarter-second ticks.
for q in 6 12 18; do
  add "drawbox=x=$(( q * SLOT - 1 )):y=ih-168:w=3:h=86:color=white@0.9:t=fill"
done

# Phase marker: one static box per slot, lit on its own frame.
for s in $(seq 0 $(( FPS - 1 )) ); do
  add "drawbox=x=$(( s * SLOT + 2 )):y=ih-160:w=$(( SLOT - 4 )):h=70:color=white:t=fill:enable='eq(mod(n\,$FPS)\,$s)'"
done

# Binary frame counter, most significant bit leftmost.
for i in $(seq 0 $(( BITS - 1 )) ); do
  bit=$(( BITS - 1 - i ))
  pow=$(( 1 << bit ))
  x=$(( 60 + i * 90 ))
  add "drawbox=x=$x:y=ih-80:w=70:h=60:color=gray@0.25:t=fill"
  add "drawbox=x=$x:y=ih-80:w=70:h=60:color=lime:t=fill:enable='eq(mod(floor(n/$pow)\,2)\,1)'"
done

printf '%s\n' "$f"
