# 検証範囲

開発コンテナ（Bun 1.4.3）で、依存導入、型検査、通常ビルド、全461件の自動テストを実行し、成功を確認した。

単一バイナリと受入ドライバーを生成し、ソース・node_modules・Bun・Node・npm・ghのない分離コンテナで次を確認した。

- version/helpの表示
- 外部gh不在の診断
- 不正設定・引数の拒否
- 疑似端末でのshow TUI操作と記録不変
- 実行対象バイナリのSHA-256照合

自動試験では実Git・一時リポジトリ・worktree・保存処理・検証コマンドを使用する。GitHub APIとCodex応答はテストダブルを使う。

実GitHubへのAPI書き込み・push、実Codexモデルによる全工程、実端末での視覚的な操作確認、他OS/CPU/libc、長時間運用は未検証。[実接続手順](github-live-validation.md)と[開発環境](development.md)を参照。
