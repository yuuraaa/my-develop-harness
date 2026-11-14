# 利用手順

GitHub Issue URLまたは `owner/repo#番号` を指定する。通常版はBun 1.4.3で起動し、[単一バイナリ](standalone.md)も利用できる。両方ともGit・外部 `gh`・SDK互換Codex CLIが必要。実GitHub/実Codexの全工程は[実施記録](validation.md)で代役テストと区別する。

```sh
docker compose up -d --build dev
docker compose exec -T dev bun install --frozen-lockfile
docker compose exec -T dev bun run build
# 以下は用意した実行環境で実行する。
harness --version
harness doctor 'owner/repo#123' --repo /absolute/path/repo
harness run 'owner/repo#123' --repo /absolute/path/repo
harness watch --dry-run
harness watch --interval 60
```

`--version`と履歴閲覧は設定・認証・外部接続不要。開発用Composeは認証や外部gh、Codex CLIを自動で用意しない。[GitHub接続の準備](github-connection.md)と[専用Codexホーム](codex-home.md)を参照。

## 設定と認証

[設定例](../examples/github-config.example.json)を `~/.harness/config.json` に置く。`--config`で別のファイルを指定できる。設定内の相対パスは設定ファイル所在、`--repo`の相対パスは起動cwdを基準とする。JSONの `~` や `$HOME` は展開しない。

- `schemaVersion: 2`、`github`を指定する。未知のキーや不正値はエラーにする。
- `github.writeTokenEnv` / `readTokenEnv` は認証環境変数の名前。既定は `HARNESS_GITHUB_WRITE_TOKEN` / `HARNESS_GITHUB_READ_TOKEN`。別々の権限で発行した異なる値を使い、値を設定ファイルへ書かない。
- `watch.repositories` は監視する `owner/repo` の明示一覧。ローカル探索先やcwdから監視対象を増やさない。
- `repository.searchRoots` / `cloneRoot` はローカルclone探索・作成先。手動runはwatch一覧外のrepoも指定できる。
- `repositories["owner/repo"]` で `pushRemote`（既定origin）、`requiredSources`を指定できる。fetch/push先はIssue所属repoと照合し、fork提出しない。

認証は既存ghログインやSSH agentへフォールバックしない。書き込み用はハーネスのAPI/Git操作だけに使い、Codexへは専用読み取り用gh認証だけを渡す。認証の実権限は発行側で保証する。

## 手動runと再実行

openかつenabled＋単一readyラベルの末端Issueが対象。担当者・優先度ラベルは条件にしない。依存Issueはcompletedとしてcloseされ、信頼できる最新成果報告と必要コミットの包含が確認できる必要がある。

初回Planが管理単位の内容からブランチを命名し、以後は保存済み対応を使う。同Issueの再実行は既存worktreeを再利用して新Planを作る。前工程のresumeや検証成功の流用はしない。worktree・記録は自動削除しない。[作業環境と復旧](github-workspace.md)を参照。

Plan→Implementation→正式検証→独立Review/Fix→コミット→通常fast-forward push→成果コメント1件→reviewラベル確認まで成功して終了0。blocked/stopped/提出部分成功は終了1、引数・設定不正は終了2。公開済み成果を取り消さず、`submission.json` に各段階の成功・失敗・未確認を残す。PR作成・Issue close・mergeは行わない。[提出の詳細](submission.md)を参照。

runは進捗を既定表示し、`--no-progress`で省略できる。run ID・最終結果・記録先・エラーは残る。runningは保存状態であり現在のプロセス稼働を保証しない。複数run/watch間のロックやPID確認は行わない。異常終了後は前処理が停止済みであることを利用者が確認する。

## watch

設定した全repoの全ページから候補を取得し、作成日時→owner/repo→Issue番号の順に整列する。親や依存待ちを飛ばして理由を表示する。待機だけではラベル・コメントを更新せず、全件待機・候補なしなら既定60秒後に再評価する。提出成功後は全repoから候補を再取得し、実行がblocked/stoppedならwatchも停止する。

Ctrl+Cは待機を中断し新規着手を止める。実行中Issueは別セッションの子プロセスで終了まで待つ。`--dry-run`は一周期の候補・待機理由・最初の選択Issue・repo/clone予定先・push remoteを表示する。外部更新、clone/fetch、worktree、実行記録、モデル呼び出しは行わない。実runの成功は保証しない。

## doctor

```sh
harness doctor
harness doctor 'owner/repo#123' --repo /absolute/path/repo --json
```

gh/Git/Codex CLI、明示認証、専用ホーム、保存先の既存祖先、GitHub読み取り可視性を確認する。Issue指定時は手動runと同じ文脈取得・着手判定で、repo/push先、開始SHAの指示・必須資料、依存待ち理由、再利用元を読み取り診断する。cloneがない場合はAPIで資料とコミット包含を確認する。ローカルobjectがない場合もfetchしない。

診断は更新・clone・fetch・worktree・実行記録を作らない。読み取り成功は書き込み権限やpush成功を保証せず、モデル利用可否や実run中の競合も未保証。待機理由は警告で表示し、設定・取得失敗は異常として終了1にする。

## 履歴と振り返り

```sh
harness history --issue 'owner/repo#123' --limit 10
harness status <run-id>
harness show <run-id>
harness show <run-id> --phase review:1 --no-pager
harness show <run-id> --phase verification:1 --log unit-tests
harness show <run-id> --phase push
```

historyは更新日時降順で既定20件。Issueと保存状態で絞り込み、壊れた記録は警告して他の履歴を表示する。worktree削除後も記録を読める。status/showは保存された実worktreeパスと再利用元を表示する。

対話端末のshowは工程一覧TUI。上下キーで選択、Tab/Enterで詳細、qで終了。`show.keys`/`show.colors`で変更でき、任意設定がなくても利用可能。非TTY・`--no-pager`はテキスト、工程指定の長文はlessへ渡す。全表示は保存記録だけを使い、AIを起動しない。
