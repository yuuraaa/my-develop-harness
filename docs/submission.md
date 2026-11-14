# 成果の提出と部分成功

## GitHub Issues版

手動runは `src/github-report.ts`、`src/github-submission.ts` を使い、コミット後に新規Reportセッションで変更要約とIssue本文の完了条件ごとの確認・根拠を生成する。正式検証・独立Review・未検証事項は最終Reviewへ渡した保存記録、累積コミットは実Gitを正とし、JSON/Markdownを保存・再照合する。

提出は以下の順に実行する。

1. 設定remoteのfetch/push URLがIssue所属repo一件と一致し、remote SHAが開始時と同じことを再確認する。ローカル成果refを期待旧SHA付きでfast-forwardし、対応記録のlocalTipを保存する。レビュー済みtree・clean・累積SHAを再照合し、固定SHAから明示した成果refへ通常pushする。push後のremote SHA一致を確認してremoteTipを保存する。
2. 保存済み `report.md` と同じ成果コメントを一件投稿する。変更要約・完了条件・正式検証・独立レビュー・未検証事項・run ID・ブランチ・累積成果SHA・開始/終了SHA固定のcompareリンク・機械可読成果マーカーを含む。
3. reviewを追加→runningを削除→全ページの状態集合がreview一件か確認する。enabled・無関係なラベルは個別更新で保持する。

開始時との照合と通常pushは原子的ではない。他者更新はFF可能でも検知時に停止し、競合による拒否も自動merge/rebase/force/別名振替で回復しない。pushは一回だけ。応答不明でもremoteが期待SHAなら成功、開始時SHAなら非反映、他SHA/取得不能ならunknownとして停止する。公開先は認証用transportがIssue所属repoの固定HTTPS URLを使う。実API/認証の仕様は[Git push](https://git-scm.com/docs/git-push)、[Issueコメント](https://docs.github.com/en/rest/issues/comments)、[ラベル](https://docs.github.com/en/rest/issues/labels)を参照。

コメント応答不明は全コメントからrun ID・本文hash/完全一致を照合し、一件だけ一致すればID/URLを保存する。不在・異内容・複数・全件取得不能では再投稿しない。ラベルは既存の照合付き更新を使用し、既知の旧/新状態だけなら残操作を行う。矛盾・未確認なら停止する。

### 記録と停止後の確認

`artifacts/report.json`・`report.md` は投稿予定本文と提出前の事実。成果マーカーの `publication: confirmed` はpush照合後に投稿するものであり、ローカル報告だけを公開成功の証拠にしない。`artifacts/submission.json` が各段階の結果の正となる。`push/comment/reviewState` ごとにstatus、attempts、intendedAt/completedAt、expected/observed、error/retryAfterを保存する。push・コメントは最大一回、ラベルは追加/削除の実書き込み回数を保存する。

操作前にin_flightを保存し、成功の記録失敗もunknownとして後続を実行しない。未実行はnot_startedのまま。pushには公開先・開始/期待/観測SHA、コメントにはIssue ID・run ID・本文hash・ID/URL、ラベルには旧/新ラベルと観測状態集合が残る。`labels-submission-*.json` とeventsも照合に使える。永続保存自体が失敗した場合、最後のin_flightと保存先を人間が確認する。レート制限では再アクセス可能時刻を保存し、追加照合や停止反映を控える。

三段階すべて成功した場合だけ正常終了。部分成功はstoppedとして停止反映を試みるが、公開済みコミット・コメント・ラベルを取り消さない。review反映済みで記録だけ失敗した場合も成功と推測しない。成果を含むローカルref/worktreeと全記録を保持する。

PR作成・Issue close・マージは行わない。人間が状態を単一readyへ戻した場合は新run/新Plan/新検証/新Reviewとして充足を再評価する。開始時remoteが今回の成果SHAと一致していればpushを再送せず、新runの成果コメントとreview更新を行う。

### 人間の依存成果報告

依存先は人間によるcompleted closeと、最新の信頼できる同書式の成果報告・Git包含を両方確認する。投稿可能な全文例は[成果コミットあり](../examples/github-result-human.md)と[成果コミット不要](../examples/github-result-no-commit.md)。対象repo/Issue番号/理由と、必要ならブランチ/完全SHAを実際の値に置き換える。訂正は新コメントにする。source=human、runId=null、write/maintain/adminの人間投稿者を要求する。noCommitRequiredは理由を必須とし、コード変更不要のときだけ使う。harnessの変更不要再実行は既存成果SHAを報告する。

テストは `tests/github-workflow.test.ts` と `tests/github-context.test.ts`。ローカルbare remote・実Git/worktree・正式検証と代役API/SDKで成功/競合/応答不明/保存失敗/人間の成果証拠を検証する。実GitHub・実Codex全工程の[実施状況](validation.md)は代役テストと区別する。
