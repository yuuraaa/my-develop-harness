# my-develop-harness

GitHub Issuesの要件から計画、実装、検証、独立レビュー、コミット、成果公開までを実行するCLIです。Codex SDKを使い、ハーネスの書き込み認証とエージェントの読み取り認証を分離します。

## セットアップ

実行環境にはGit、GitHub CLI（gh）、SDK互換のCodex CLIが必要です。ソース版はBun 1.4.3を使用します。単一バイナリ版はBunの導入を必要としません。

1. examples/config.example.jsonを ~/.harness/config.json にコピーし、探索先と監視対象を設定します。
2. .env.exampleに従って、読み取り用と書き込み用の異なるGitHubトークンを環境変数へ設定します。
3. Codexの認証を準備し、HARNESS_CODEX_PATHにCLIの絶対パスを指定します。
4. 対象リポジトリにharness用ラベルを作成し、doctorで接続と前提条件を確認します。

~~~sh
harness doctor
harness run 'owner/repo#123' --repo /absolute/path/to/repo
harness watch --dry-run
harness watch
harness history --issue 'owner/repo#123'
harness status <run-id>
harness show <run-id>
~~~

Issueにはharness:enabledとharness:readyを付けます。runは通常push、成果コメント、harness:reviewへの更新まで行います。PR作成・Issueのclose・mergeは人間が行います。

## ドキュメント

- [利用手順](docs/usage.md)
- [仕様](docs/specification.md)
- [設計](docs/architecture.md)
- [GitHub接続と認証分離](docs/github-connection.md)
- [作業環境・ブランチ・再実行](docs/github-workspace.md)
- [Codexホームと権限](docs/codex-home.md)
- [実行処理](docs/runtime.md)
- [成果提出](docs/submission.md)
- [開発環境と検証](docs/development.md)
- [単一バイナリ](docs/standalone.md)
- [実接続検証](docs/github-live-validation.md)
