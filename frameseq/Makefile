.DEFAULT_GOAL := help
BIN  := bin/server
ADDR ?= :8080
ARGS ?=

help: ## List targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-12s %s\n", $$1, $$2}'

build: ## Build the server
	go build -o $(BIN) ./cmd/server

run: build ## Serve the harness on $(ADDR)
	./$(BIN) -addr $(ADDR) $(ARGS)

sample: ## Build and ingest a synthetic clip with a burned-in frame indicator
	./scripts/make-sample.sh

ingest: ## Ingest one video: make ingest SRC=path/to.mp4 [ARGS='--scale 1280x720']
	@test -n "$(SRC)" || { echo 'usage: make ingest SRC=path/to/video.mp4'; exit 2; }
	./scripts/ingest.sh "$(SRC)" $(ARGS)

ingest-all: ## Ingest every new video in sources/
	./scripts/ingest-all.sh $(ARGS)

clips: ## List what has been ingested
	@./scripts/list-clips.sh

clean: ## Remove build output (leaves ingested clips alone)
	rm -rf bin

distclean: clean ## Also remove every ingested clip
	rm -rf media

.PHONY: help build run sample ingest ingest-all clips clean distclean
