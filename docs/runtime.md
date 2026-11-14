# CLIと実行記録

GitHub Issueの実行はsrc/github-workflow.tsを入口とする。

## GitHub Issues版の手動run

```sh
harness run 'owner/repo#123' --repo /path/to/clone
harness run https://github.com/owner/repo/issues/123
harness status <run-id>
```

設定は `schemaVersion: 2` の [設定例](../examples/github-config.example.json)。認証の環境変数名は設定に従う。
`--repo` は起動cwd基準、省略時は設定した探索先を使う。番号のみ・PRは拒否する。
ブランチは初回Planの内容命名と保存済み対応を使う。

対象/関係取得→clone・開始SHA確認→依存/開始資料/過去run入力の確認→worktree準備→読み取りPlan→対応予約・ref作成→readyからrunningへの更新確認→Implementation→正式Verification→独立Review/Fix（最大3回）→コミット・Git整合性確認の順に処理する。
Planで止まった場合は外部のラベル・コメントを変更しない。着手後の要件・完了条件は開始時に保存したIssue本文を基準とし、途中の本文・enabled除去を追跡しない。

コミット・Git照合後は読み取り専用の新規Reportセッションで完了条件の確認と変更要約を生成し、保存済みの正式検証・Review・Git成果を結合して報告を保存する。開始時remote SHAと公開先を再照合し、fast-forward push→成果コメント一件→reviewラベル更新を順に確認した場合だけ `completed`・終了コード0とする。[提出記録と障害対応](submission.md)を参照。部分成功では停止・終了コード1とし、公開済み成果を保持する。

`GitHubControl` は人間判断なら `blocked`、技術障害なら `stopped` としてローカル停止を先に確定する。着手成功後だけ、新状態ラベル追加→running削除→状態集合の再取得確認を行う。無関係なラベルを置換しない。
blockedでは理由・選択肢・推奨コメントを追加し、応答不明なら全コメントの完全一致を照合して二重投稿を避ける。ラベル更新も反映を確認した残操作だけ行う。レート制限中は追加の照合・理由投稿をしない。
更新失敗/不明、停止保存失敗はCLIへ表示し、開発を続行しない。途中のref・コミット・dirty/index/untrackedを削除しない。

状態形式は `schemaVersion: 2, backend: github`。`RunStore.initializeGitHub` はID取得前にも新runの記録先を確保し、`prepare-input.json` と取得失敗時の `prepare-failure.json` を残す。Issue/repository IDが確定してから `saveGitHubState/loadGitHubState` でstateを保存し、未確定パス/SHAはnullにする。取得前の失敗ではIDを推測したstateを作らない。
stateはIssue・管理単位・成果/作業ブランチ・実worktreeパス・累積base/再実行HEAD・開始remote SHA・工程・検証・レビュー・コミットを保持する。`startTransition` と `stopReflection` で着手/停止の反映状態を区別する。提出工程は `push/comment/review_state`、`submissionArtifact` は `submission.json` を参照する。三段階すべての成功確認後だけcompletedへ遷移する。

同じIssueの再実行は新run・新エージェントで既存worktreeを再利用する。`restart.json` と文脈の `previousInputs` に過去のstate/Plan/実装/正式検証/Review/コミット・現在の累積diff/指示差分を保持し、合計文脈上限を適用する。
初回baseからの累積diffを毎回新しく検証・レビューする。開発中のHEAD固定は今回の再実行HEAD、Reviewと成果コミットの範囲は初回baseにする。変更不要でも空コミットを作らず、現在treeとHEADの一致・clean状態・累積成果を確認する。
過去runは上書きしない。同じ管理領域を使うrun/watchは利用者が逐次起動する。

statusは保存状態・実worktreeパス・再利用元・成果と作業ブランチ・着手と停止反映を表示する。
