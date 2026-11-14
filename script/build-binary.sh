#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

project_name="my-develop-harness-binary-$$"

cleanup() {
    docker compose -p "$project_name" down --rmi local --volumes
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose -p "$project_name" up -d --build dev
docker compose -p "$project_name" exec -T dev bun install --frozen-lockfile
docker compose -p "$project_name" exec -T dev bun run build:binary
