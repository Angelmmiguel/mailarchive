# Development commands. Run them inside the Nix shell (`nix develop`, or let
# direnv load it for you).

default: test

# Run the server against ./data.
serve *args:
    go run ./cmd/mailarchive serve --data ./data {{args}}

# Run the test suite with the race detector.
test:
    go test -race ./...

# Vet and lint everything.
lint:
    go vet ./...
    golangci-lint run

# Build the binary into bin/.
build:
    go build -o bin/mailarchive ./cmd/mailarchive

# Report files that gofmt would change.
fmt:
    gofmt -l .
