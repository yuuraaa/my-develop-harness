# 単一バイナリ

BunのコンパイルでLinux x64向けの実行ファイルを生成する。

~~~sh
docker compose exec dev bun run build:binary
docker compose exec dev sh scripts/build-standalone-tests.sh
sh scripts/verify-standalone-worktree.sh
~~~

本体はbuild/harness-linux-x64。実行先にBun/Node/npmは不要だが、Git・gh・SDK互換のCodex CLIは別途必要。HARNESS_CODEX_PATHにCodexの絶対パスを指定する。認証と設定は[GitHub接続](github-connection.md)を参照。

分離受入ではbuild成果物をread-onlyで渡し、SHA-256で対象を照合する。ソースとnode_modulesのない環境でversion/help、外部gh不在診断、不正設定・引数の拒否、show TUIと記録不変を確認する。対象OS/CPU/libcの互換性、実モデル、実GitHub、長時間運用の検証とは区別する。
