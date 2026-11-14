#!/bin/sh
# コンテナ内で実行する。全件を実行し、終了コードと診断を保持する。
set -eu
task_test_logs=$(mktemp -d /tmp/harness-tests.XXXXXX) || exit
if bun test > "$task_test_logs/stdout.log" 2> "$task_test_logs/stderr.log"; then
  task_test_code=0
else
  task_test_code=$?
fi
printf 'Full test output: %s\n' "$task_test_logs"
cat "$task_test_logs/stdout.log" || exit
# 保存上限をpass行で使い切らない。失敗の診断と最終集計は省かない。
awk '!/^\(pass\)/' "$task_test_logs/stderr.log" >&2 || exit
printf 'bun test exit code: %s\n' "$task_test_code"
exit "$task_test_code"
