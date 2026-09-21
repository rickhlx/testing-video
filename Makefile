.DEFAULT_GOAL := help
BIN  := bin/server
ADDR ?= :8080

help: ## List targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-10s %s\n", $$1, $$2}'

media: ## Generate the 1080p24 test media (idempotent, ~4 min on first run)
	./scripts/make-media.sh

build: ## Build the server
	go build -o $(BIN) ./cmd/server

run: build media ## Serve the matrix on $(ADDR)
	./$(BIN) -addr $(ADDR)

tls: build media ## Serve over HTTPS, needed by WebCodecs/PiP on remote clients
	./$(BIN) -addr $(ADDR) -tls

clean: ## Remove build output (leaves generated media alone)
	rm -rf bin

distclean: clean ## Also remove generated media
	rm -rf media

.PHONY: help media build run tls clean distclean
