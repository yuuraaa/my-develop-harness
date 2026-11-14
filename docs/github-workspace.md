# GitHub Issueのブランチと作業環境

現行の作業環境API。[正本](specification.md)と[詳細仕様4・5章](specification.md)の2026-11-08合意に従う。
run/watch/doctorはIssue所属リポジトリを対象とする。

## 利用側からの呼び出し順

1. Issueの文脈取得・管理単位判定を使い、Issue所属の正規化repo名・API IDを確定する。
2. `workspaceGit`で空HOMEを使うローカルGitコマンドを作る。`repositoryTransport`へ明示write tokenを渡し、認証設定の検査は通信前に行う。tokenを記録しない。
3. `inspectIssueRepository`で`--repo`または探索設定からcloneを選ぶ。自動探索は`searchRoots`と`cloneRoot/harness-clone`だけを使う。
   必要なら`acquireIssueRepository`で非対話cloneする。失敗時は部分cloneを保持し、自動再送や削除をしない。
4. `prepareIssueWorkspace`へ新run ID・対象と管理単位のID/名前/番号・元clone実パスを渡す。
   `confirmStart(startCommit, checkInclusion)`内で依存判定と開始SHAの必須資料取得を行う。
   `evaluateIssueEligibility`へ同じSHAと`gitInclusion`を渡し、waitingや資料未完了では例外で止める。
5. `savePrepared`は**新run**のstateと、再利用時は`restart`/累積diffを永続保存する。初回はworktree作成前にも呼ばれる。
   一度保存した実パスを使い、run IDからworktreeパスを再構築しない。過去runのstate/events/artifactsは変更しない。
6. `planIssueBranch`へ、管理単位Issueの本文・全コメントを`managementContent`として渡し、読み取り専用Planを呼ぶ。
   管理単位自身なら対象、子なら対応する祖先の取得済み本文を使う。命名と対象Issueの計画を同じPlanで行う。
   初回のみ命名し、形式・衝突が不正なら理由を渡して最大3回。既存名では新計画だけを作り、返された別名は採用しない。
7. Plan成功・ref作成・created保存が揃ってからready→runningを反映する。着手前にIssueコメントを投稿しない。
   このAPIはGitHub状態更新・push・merge/rebase・自動削除を行わない。

`savePrepared`はstateの必要フィールドを`workspaceRunSchema`で検証できる。
`startCommit`/`branchRecord`/`remoteHeads`/`restart`/`warnings`は準備APIの付加情報であり、そのままstateへ混ぜない。
`warnings`には所属や予約名を読めない記録のパスを返す。呼び出し側は警告を表示・保存し、無関係な破損を着手の停止条件にしない。
対象Issueまたは管理単位と分かる履歴は完全検証し、決定runや再実行chainの参照先欠落は停止する。
記録全体・工程/ラベル・Plan出力・再利用時の予算計上/表示にも接続する。
開始資料は再利用HEADのSHAから取得し、`restart.instructionDiff`と累積diff内の未追跡指示もPlanへ渡す。
`restart.previousRuns`は過去の停止・検証・Review記録を読む参照先であり、過去の成功を今回の検証として採用しない。

## リポジトリと開始点

push remoteは`repositories["owner/repo"].pushRemote`、既定`origin`。
実効fetch URLとpush URLをそれぞれ一件必要とし、Issue所属repoとの一致を検証する。fork提出・複数push先・認証入りHTTPS URLを拒否する。
SSH形式は照合だけに使い、実通信は設定を書き換えず確定したHTTPS宛先と明示認証で行う。
repoローカルのcredential/http/include/URL書換えは認証を渡す通信前に認証基盤が検査する。ローカルの読み取りごとには再検査しない。暗黙のhelperやSSHへフォールバックしない。

初回はcleanな既定ブランチのcloneが必要。remote SHAを照会してfetch結果と照合し、ローカル独自履歴がなければff-only更新する。
後続の別Issueは共有成果ブランチのremote最新SHAから開始し、未承認でもpush済みの成果を含める。
既定ブランチの照会は初回開始点を決める場合だけ必要とし、後続Issue・再実行・Planは成果ブランチと対象候補名を照合する。
fetchの途中でSHAが変われば停止する。開始時remote成果ブランチが存在しなければ`remoteStartCommit=null`を保存する。
依存包含は完全SHAのcommit objectと`merge-base --is-ancestor`で検証し、欠落・Git障害を未確認として待機へ渡す。
replaceを無効にし、graftsがある場合も未確認にする。別repoの成果を自動取得・mergeしない。

成果ブランチはcheckoutせず、各初回worktreeの作業用ブランチ`harness/run/<worktreeOriginRunId>`を使う。
人間が成果ブランチを別worktreeでcheckoutしていれば、その作業先を変更せず停止する。
成果refは対応記録の期待SHAと照合し、後続のremote先行は包含確認後に期待旧SHA付き`update-ref`でFFする。
レビュー後の成果ref更新・push・対応記録の最新tip保存は `submitIssueResult()` が行う。期待旧SHA付きでローカルrefをFFしlocalTipを保存、開始時remote SHA一致と通常push後の期待SHA一致を確認してremoteTipを保存する。[提出記録](submission.md)を参照。

## 対応記録と停止

対応は`~/.harness/branches/<repositoryId>/<managementIssueId>.json`。
repo/Issueの数字IDと名前・番号、成果ブランチ、決定run、初回開始SHA、作成状態、local/remote tip、更新時刻を保存する。
名前は`feature/fix/hotfix/chore/docs/refactor/<英語ケバブケース>`。Issue番号からの自動命名はしない。

Plan後、同repoのlocal/remote名・他管理単位の予約を検査し、`reserved`を新規保存・fsyncしてからrefを作る。
他管理単位の予約からは衝突判定に必要な名前だけを読み、今回使う対応記録は全項目を照合する。
確認後に`created`へ更新する。ハーネスのプロセスロック・PID検査は作らない。
新規JSONの作成競合やrefの期待値不一致は停止する。複数プロセス/別マシンの協調動作は保証しない。

reserved中断、記録欠落/破損、決定run欠落、改名/移転、ローカルref不一致、無関係な同名branchは自動修復しない。
別Issueのdirty・未push成果・push in_flight/unknownがあれば、そのIssueの再実行か人間の整理を求めて停止する。
公開済みの別Issueのworktreeが手動削除済みなら、残る作業用ブランチの成果がremoteに含まれることを確認して進める。ref欠落や未包含・push未確認は停止する。同Issueの再実行では再利用先のworktreeが必要。
ready復帰だけでは別Issueへ成果を移さない。成果の扱いは利用者が判断する。

## 同Issueの再実行

の過去stateをrepo ID＋Issue IDで照合し、previousRunIdで連続するchainの末尾を一意に特定する。
新しい日時だけで選ばない。候補複数・不連続chain・worktree欠落・common directory/実パス/作業用branch不一致は確認待ちで停止する。
記録された実パスのworktreeを再利用し、index・dirty・未追跡ファイル・未pushコミットを保持する。
実パスとGitの登録・common directoryを照合し、run IDから保存場所を組み立て直して一致を要求しない。管理領域の親ディレクトリや管理領域自体のsymlinkも一律には拒否しない。
remote成果が再利用HEADに含まれなければ、先行/分岐として停止し、自動merge/resetしない。

新runには最初の`baseCommit`、今回の`restartHead`、`remoteStartCommit`、前run/初回runのIDを保存する。
再利用時の指紋はHEAD・index・未追跡を含む。累積diffは一時indexから取得し、実indexを書き換えない。
認証ファイル・バイナリを記録から除外し、認証文字列をマスクして未確認箇所を`redactions`へ残す。
前回の成果を含め、新しいPlan→正式検証→独立Reviewを行う。前のSDKセッションは再利用しない。

## バックアップと手動復旧

停止時はCLI/run記録の理由と候補を確認し、元cloneの`git worktree list --porcelain`、branch refの完全SHA、remote SHAを照合する。
異常終了後に残った処理の停止確認は利用者が行う。起動中run/PIDやラベルから生存状態を推測しない。

復旧前に`branches`と`runs`だけでなく、元cloneのGitオブジェクト/refs・全関連worktreeの未コミット/index/未追跡ファイルを一緒にバックアップする。
`worktree`の`.git`ファイルだけを保存しても成果コミットやindexを復元できない。
管理単位のID/名前/番号、決定run ID、成果名、初回baseとtip、Git common directoryを確認してから、バックアップを基に必要な記録を手動復旧する。
reserved中断は作成済みrefとrunを照合し、初回として名前を作り直さない。取り込みや不採用の判断は人間が実物を確認して行う。
自動削除・タイトルからの推測再生成・日時だけの選択で矛盾を解消しない。過去state/events/artifactsを上書きしない。

## 検証範囲

`tests/github-workspace.test.ts`で実ローカルGitとbare remoteを使う正常/異常系を確認する。
認証の通信先は代役プロセスで照合し、実GitHubへのpush・Issue投稿は行わない。
run/状態/累積Reviewを含む対応表・実施結果は[統合検証記録](validation.md)を参照。
Web UIはないためブラウザ検証対象はない。
