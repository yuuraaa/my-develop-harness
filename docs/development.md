# 開発環境と検証

開発はコンテナ内で行う。ホストにはGit、Docker Engine、Compose v2が必要。開発イメージはBun 1.4.3とGitを含み、Node.js/npmは導入しない。UID/GIDは1000、ソースは/workspace、依存とdistは名前付きvolumeに保存する。

~~~sh
docker compose up -d --build dev
docker compose exec dev bun install --frozen-lockfile
docker compose exec dev bun run typecheck
docker compose exec dev bun run build
docker compose exec dev bun test
docker compose exec dev bun run build:binary
docker compose exec dev sh scripts/build-standalone-tests.sh
sh scripts/verify-standalone-worktree.sh
~~~

bun.lockで依存を固定する。依存更新はコンテナ内でbun add --exactを使用し、package.jsonとbun.lockを一緒に更新する。bun-typesの型補正はpatches/内のパッチを適用する。Codex SDKの公開型定義に必要なMCP SDKを開発依存に含む。

テストはCLI、保存記録、認証分離、GitHub API、Issue文脈、依存判定、ブランチ/worktree再利用、正式検証、レビュー、コミット整合性、成果提出の部分成功を確認する。Gitと一時リポジトリを使い、外部APIとCodexはテストダブルに置き換える。模擬APIの成功は実GitHubへの接続や実モデルの動作確認を意味しない。

showのTUIは疑似端末でも検証する。実端末では次のスクリプトで、一覧・詳細の移動、スクロール、終了、キー設定、リサイズ、端末復元を確認できる。

~~~sh
docker compose exec dev bun scripts/show-terminal-manual.ts
~~~

/tmpは最大1GiBのtmpfsで、状態保存の同期書き込みとテスト代役CLIの実行に使用する。全件ログを保存する場合はsh scripts/test-with-summary.shを使う。実行記録の保存先は出力で確認する。

基本のComposeはホストの認証情報、~/.harness、Docker socketをマウントしない。実運用では[利用手順](usage.md)に従い、永続保存先と明示認証を用意する。.env.exampleは変数名の例であり、Composeが自動で実行環境へ渡す設定ではない。

検証結果には、実際に実行した環境・対象・コマンド・成否と未実施項目を記載する。実GitHub・実Codexの検証には[実接続手順](github-live-validation.md)を用いる。
