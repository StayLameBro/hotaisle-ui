VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: build web run demo test test-ui release

build: web ## build bin/hotaisle-ui with the web app embedded
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/hotaisle-ui .

web:
	cd web && npm ci --no-audit --no-fund && npm run build

run: build ## open with your Hot Aisle CLI login
	./bin/hotaisle-ui

demo: build ## open with sample data
	./bin/hotaisle-ui --demo

test:
	go vet ./... && go test ./...
	cd web && npm run typecheck

test-ui: build ## layout stability in headless Chrome: nothing may move unless the view changes
	node web/tests/stability.mjs

release: web ## cross-compile into bin/
	for t in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do \
	  os=$${t%/*}; arch=$${t#*/}; ext=$$( [ $$os = windows ] && echo .exe ); \
	  GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o bin/hotaisle-ui-$$os-$$arch$$ext . ; done
