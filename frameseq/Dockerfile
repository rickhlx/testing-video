# Three stages: ingest the clips with ffmpeg, compile the server, then assemble
# a distroless image holding the binary, web/ and media/. Nothing that the build
# can produce is committed.

# ------------------------------------------------------------------ clips
FROM debian:bookworm-slim AS media
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/ scripts/
# Anything in sources/ is ingested at build time. It is gitignored, so a clone
# builds with the synthetic clip alone and a local build carries whatever you
# dropped in.
COPY sources/ sources/
ARG SAMPLE_DUR=30
ARG SAMPLE=1
RUN if [ "$SAMPLE" = "1" ]; then DUR=$SAMPLE_DUR ./scripts/make-sample.sh; fi
RUN ./scripts/ingest-all.sh || true

# ----------------------------------------------------------------- server
FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ------------------------------------------------------------------ image
FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /out/server /app/server
COPY web/ /app/web/
COPY --from=media /src/media/ /app/media/
EXPOSE 8080
ENTRYPOINT ["/app/server"]
