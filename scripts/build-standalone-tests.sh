#!/bin/sh
set -eu
bun run build:binary
bun build --compile --target=bun-linux-x64 --minify tests/standalone/acceptance.ts --outfile build/acceptance
