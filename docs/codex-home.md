# Codexホームとフェーズ別権限

Codexは専用読み取りghで調査する。[認証分離](github-connection.md)を参照。

Codex CLIの実行ファイルは `HARNESS_CODEX_PATH`（実行可能な絶対パス）を最優先し、未指定時はPATH順に探索する。
明示パスの不備ではフォールバックしない。Bunソース・tsc成果物起動のみ、PATHで見つからなければ従来のSDK既定探索を維持する。
コンパイル版は外部CLIが必須で、SDKのnode_modules内探索を利用しない。詳細は[単一バイナリ](standalone.md)を参照。

Codex CLI / SDK 0.162.1を使用する。普段使いのCodexでログインしたユーザーの`~/.codex/auth.json`を認証元とし、追加ログインや認証のコピーは行わない。ユーザーホームは起動環境のHOME（未指定時はOSのホーム）から決定する。`CODEX_HOME`の環境変数から認証元を選ばない。

## 初回作成と編集

`execution.codexHome`を省略すると`~/.harness`。指定時は専用ディレクトリの絶対パスを使う。`execution`自体は従来どおり必要で、既定値なら`"execution": {}`とする。

```text
~/.harness/
  config.json              # ハーネス設定
  auth.json -> ~/.codex/auth.json
  config.toml              # ユーザーが編集するCodex設定
  rules/
    plan.rules
    implementation.rules
    fix.rules
    review.rules
    commit.rules
    report.rules
  codex-run-<乱数>/         # 接続ごとの実行用CODEX_HOME、セッションを保存
    auth.json -> ~/.codex/auth.json
    config.toml            # フェーズ起動時点の専用設定の写し
    rules/active.rules     # 対象フェーズの1ファイルのみ
  runs/<run-id>/
  worktrees/<run-id>/
```

初期config.tomlは`cli_auth_credentials_store = "file"`。普段使いのconfig.toml・rulesは継承しない。新規ディレクトリは0700、ファイルは0600で作成し、既存の設定・ルールの内容やモードをリセットしない。認証元の内容は初期化処理で読み取らない。

初回作成後は、編集用ホームのconfig.tomlと各.rulesを直接編集する。各フェーズの起動前に再読するため、次のCodex呼び出しから反映する。実行中のCLIに対する変更は次回から有効。共通ルールファイルやVerification用.rulesは設けず、追加した別名.rulesも自動適用しない。相対パスを含むCodex設定は実行用ホームを基準に解決されるため、設定から参照するパスは絶対パスで記述する。

実行用ホームは接続ごとに独立し、同じrun内で共有する。各Plan命名試行は読み取り専用の新規セッションとし、採用したPlanのIDだけをImplementation/Fix/Commitでresumeし、文脈を保ったまま毎回新しいSDK/CLIに権限を渡す。ReviewとReportは新規セッション。途中障害からの自動resumeはしない。セッション調査用に実行用ホームを残すので、プロセス終了と記録の不要を確認してから手動で整理する。ホーム全体を公開しない。

## 初期権限

| フェーズ | ファイル操作 | Git | Dockerの初期allow |
|---|---|---|---|
| Plan | read-only | 読み取り、add/commit禁止 | info、version、compose ps |
| Implementation / Fix | workspace-write（worktree） | 読み取り、add/commit禁止 | 上記に加えcompose up/build/exec/run |
| Verification | ハーネスが実行 | 変更は前後検査 | Codexの.rules対象外 |
| Review | read-only | 読み取り、add/commit禁止 | info、version、compose ps |
| Commit（計画のみ） | read-only | 読み取り、add/commit禁止 | 追加allowなし |
| Report | read-only | 読み取り、add/commit禁止 | 追加allowなし |

各ファイルにgit status/diff/log/show/rev-parse/ls-files/ls-treeのallowと、変更系Gitコマンドのforbiddenを明記する。branch/remoteは更新用引数も持つため初期allowには含めない。push/merge/rebase/reset等の履歴・共有状態操作、checkout/switch/restore/clean、fetch/pull、branch/remote/config/worktree/init/clone、rm/mv/apply/am/stash/tag/notes、update-ref/update-index/read-tree/write-tree/commit-tree/symbolic-ref/gc/prune/reflogを全フェーズで禁止する。Commitも含め全フェーズで`git add`・`git commit`・`git commit --amend`を禁止する。ファイルを分け、ImplementationとFixも独立して編集できる。

.rulesはコマンドprefixに対する制御であり、任意のスクリプトや引数の意味を検証する機構ではない。allowされたコマンドはサンドボックス外で実行され得る。Gitの別表記・オプション位置・スクリプト経由やDockerの引数まで網羅的に制限するものではない。例として`git commit -m x --amend`は`git commit --amend`のprefixとは異なる。プロンプトの禁止指示、サンドボックスとハーネスの前後Git整合性検査を併用する。Dockerのallowは既存OS権限でDockerを操作できる環境に限って有効で、マウント先や特権指定を自動審査しない。編集者は許可を広げる影響を確認する。

## 固定制約

ユーザー設定より優先して、MCPサーバーテーブルを空にし、書き込みトークンを渡さない。専用の空HOMEと読み取りGH_TOKENを渡し、ネットワークを有効にする。認証保存方式file、approval_policy=never、Web検索無効、追加writable_rootsなし、TMPDIRと/tmpへの追加書き込みなしを維持する。SDKのフェーズ指定によりsandbox_modeを適用し直す。

プロジェクト信頼設定も上書きし、作業リポジトリと親ディレクトリのCodex設定・ルール・hooksを読み込ませない。AGENTS.md等の作業指示の読解とは別の制約。実行用ホームのrulesにはactive.rulesしか置かず、編集用ホームの6ルールをまとめてロードしない。OS管理者・組織が定めるシステムの設定やrequirementsは引き続きCodexの制約となる。

モデルなど固定制約以外の設定はconfig.tomlで変更できる。`execution.model`を指定した場合はそちらが優先される。ハーネスが実行する準備・VerificationのコマンドにはCodexの.rulesとサンドボックスは適用されず、起動環境のOS権限・制限に従う。

CommitではCodexがファイル単位のコミット計画（作成順のメッセージと相対パス一覧）だけを返す。ハーネスが全変更の重複・漏れ・対象外パスを検査し、レビュー後の変更がないことを確認してGit操作を実行する。既存の専用ホームのルールは上書きしないため、必要に応じてcommit.rulesのadd/commitもforbiddenに更新する。
