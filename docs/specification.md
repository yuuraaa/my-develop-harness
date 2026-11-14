# GitHub Issuesの実行仕様

## 対象と状態

GitHub.comのIssue URLまたはowner/repo#番号を受け付ける。Issue所属リポジトリを唯一の作業先とし、fetch/push先も照合する。設定はschemaVersion: 2で、github、watch、repository、repositories、execution、showを定義する。[設定例](../examples/config.example.json)を参照。

open、harness:enabled、harness:readyの末端Issueが着手対象。状態ラベルはready/running/blocked/stopped/reviewのうち一つにする。ラベル変更は目的のラベル追加、変更前のラベル削除、再取得による確認の順に行う。必要ラベルは人間が事前に作成する。closeやmergeは自動実行しない。

## 文脈と依存

Issue本文・コメント・親子Issue・依存関係・開始コミット上のリポジトリ指示・必須資料を取得する。必須資料の不足や取得失敗を空の文脈として扱わない。初期取得の総バイト上限は既定10MiB。エージェントによる追加調査は専用読み取りghを使う。

依存Issueはcompletedとしてcloseされている必要がある。成果はハーネスの報告マーカーと投稿者を検証し、必要コミットの包含を確認する。単にcloseされているだけでは依存充足としない。人間が用意する報告例は[通常成果](../examples/github-result-human.md)と[コミット不要](../examples/github-result-no-commit.md)を参照。

## 作業環境と実行順序

初回Planで作業内容を示すfeature/fix/hotfix/chore/docs/refactorのブランチ名を提案する。管理単位ごとの対応記録で予約・作成状態とSHAを管理する。命名の再Planは最大3回。同Issueの再実行では保存済みworktreeを再利用し、新しいPlanと正式検証を行う。関連Issueの成果は管理単位の共有ブランチへfast-forwardで集約する。[作業環境](github-workspace.md)を参照。

実行順序は、文脈・依存判定、作業環境準備、Plan、runningラベル、Implementation、正式検証、独立Review、必要ならFixと再検証、Commit、Report、push、成果コメント、reviewラベル確認とする。

Reviewは実装用とは異なるセッションで、累積差分とハーネスが保存した正式検証を確認する。major/critical、重要な未確認事項、blockersがあれば合格にしない。Fixは最大3回、Reviewは最大4回。検証の自己申告で正式結果を置き換えない。レビュー前のcommitは禁止し、レビュー後もコード変更・履歴改変を検出したら停止する。

## 認証と提出

ハーネスは明示した書き込みトークン、Codexは別の読み取りトークンを使用する。既存ghログイン、SSH agent、credential helperへフォールバックしない。秘密値は設定JSONへ保存せず、出力と記録でマスキングする。[認証分離](github-connection.md)を参照。

成果の提出は期待SHAの照合、通常fast-forward push、push先SHAの再確認、成果コメント1件、reviewラベル確認の順に行う。各操作の意図と反映結果をsubmission.jsonへ保存し、不明反映を盲目的に再送しない。公開済み成果は取り消さない。[成果提出](submission.md)を参照。

## watch・診断・記録

watchは設定の明示リポジトリだけを監視し、候補を作成日時、owner/repo、Issue番号で整列して逐次実行する。待機・空一覧では既定60秒後に再取得し、提出成功後は即時再取得する。blocked/stoppedでwatchも停止する。Ctrl+Cは新規着手を止め、実行中Issueの終了を待つ。

doctorとwatch --dry-runは読み取り専用。実行や書き込みの成功を保証しない。runの終了コードは提出完了0、停止・blocked・提出部分成功1、引数・設定不正2。

state.json、events.jsonl、artifactsを~/.harness/runs/<run-id>/へ保存する。状態形式はschemaVersion: 2、backend: github。履歴・status・showは設定・認証・外部接続なしで保存値を読む。runningはプロセスの稼働を保証しない。

同じ管理領域を使うrun/watchは利用者が逐次起動する。共有ロックやPID確認、自動削除・自動復旧は行わない。復旧前には記録、Git common directory/refs、全関連worktree、index、未追跡ファイルを一緒に保全する。
