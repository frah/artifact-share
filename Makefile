.PHONY: build test web
build:
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/artifact-share .
test:
	go test ./...
web:
	npm ci
	npm run build
