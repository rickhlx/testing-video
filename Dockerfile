# syntax=docker/dockerfile:1

# The test media is generated rather than committed: it is ~166 MB, fully
# reproducible from the scripts, and would be miserable in version control.
# Generating it in its own stage means Docker caches it, so it is only rebuilt
# when the scripts change and not on every code edit.

# ---------------------------------------------------------------- media stage
FROM debian:bookworm-slim AS media

# Debian's ffmpeg carries libx264, libvpx and libaom. make-media.sh picks
# whichever AV1 encoder it finds, so no particular ffmpeg build is required.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY scripts/ scripts/

# Clip length. Shorter means a smaller image and less egress; 60s matches what
# the README and a local `make media` produce, so measurements stay comparable.
ARG DUR=60

# source.mp4 is only the near-lossless intermediate every encode derives from.
# It is 79 MB and nothing serves it, so it is dropped before the copy out.
RUN DUR=${DUR} ./scripts/make-media.sh \
 && rm -f media/source.mp4 \
 && du -sh media

# ---------------------------------------------------------------- build stage
FROM golang:1.23-bookworm AS build

WORKDIR /src
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/

# Static binary so the final image needs no libc at all.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ------------------------------------------------------------------ run stage
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=build /out/server /app/server
COPY web/ /app/web/
COPY --from=media /src/media/ /app/media/

# Informational only: the platform injects PORT and the server honours it.
EXPOSE 8080

ENTRYPOINT ["/app/server"]
