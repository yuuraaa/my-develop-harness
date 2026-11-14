#!/bin/sh
# ハーネスがworktreeのルートをcwdにして実行する。失敗を後続成功で隠さない。
set -eu
task_worktree=$(pwd -P) || exit
test -f "$task_worktree/compose.yaml" || exit 1
task_harness_sum=$(sha256sum "$task_worktree/build/harness-linux-x64") || exit
task_driver_sum=$(sha256sum "$task_worktree/build/acceptance") || exit
# 明示bindとコンテナ内の両成果物の照合により、別worktreeの成果物を使わない。
docker compose --project-directory "$task_worktree" -f "$task_worktree/compose.yaml" -f "$task_worktree/docker/compose.checks.yaml" -p "harness-${task_worktree##*/}" --profile standalone run --rm --build -v "$task_worktree/build:/artifacts:ro" standalone sh -ec '
actual=$(sha256sum /artifacts/harness-linux-x64) || exit
test "${actual%% *}" = "$1" || exit 1
actual=$(sha256sum /artifacts/acceptance) || exit
test "${actual%% *}" = "$2" || exit 1
exec /artifacts/acceptance
' sh "${task_harness_sum%% *}" "${task_driver_sum%% *}"
