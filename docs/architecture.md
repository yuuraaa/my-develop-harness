# 処理フローと開発フェーズ

[仕様](specification.md)と[利用手順](usage.md)を参照。

## 全工程

```text
Issue指定 / watchの候補選択
  → 対象・全コメント・祖先・直接子・依存を取得
  → 実行許可・単一ready・末端Issueを確認
  → Issue所属repoとclone / push先を照合
  → 開始SHA・依存成果の包含・開始点の指示と必須資料を確認
  → 新worktree、または同Issueの保存済み実worktreeを準備
  → 読み取り専用Plan（初回だけ管理単位の内容から命名）
  → ブランチ対応を保存 → ref作成 → created保存
  → readyからrunningへの反映を確認
  → Implementation → 正式Verification → 独立Review
       └ 修正必須 → Fix → 再検証 → 新規Review（Fix最大3回）
  → レビュー済みtreeをコミットしGit整合性を確認
  → 保存事実と新規Reportの要約・完了条件を結合
  → 通常FF pushを確認 → 成果コメント1件 → reviewラベルを確認
  → completed（人間の承認・closeとは別）
```

入口は `src/github-workflow.ts`。watchも公開CLIの同じrunを呼ぶ。`GitHubControl` が状態・保存・停止を扱い、`CodexPhases` がエージェント各工程を扱う。`DevelopmentControl/DevelopmentState` は工程間の内部型であり、汎用のタスク管理アダプターではない。

## 文脈取得と着手判定

`github-issue.ts` はURLと `owner/repo#番号` を正規化し、APIのrepo名/ID・Issue ID・URLを照合する。PR、改名/移転、不正IDは停止。`github-context.ts` は対象・祖先の全コメント、直接子、依存先本文と成果証拠、開始SHAの指示・明示必須資料を取得する。対象の最初のAPI応答を固定し、開始SHAの資料取得でIssue本文を差し替えない。

親の404は、先に可視性を確認したIssueの `parent_issue_url: null` と合わせて親なしと扱う。フィールド欠落・不一致は停止する。この実API契約は[実接続項目](github-live-validation.md)で確認が必要。

開始treeの `AGENTS.md` / `AGENTS.override.md` は適用先を記録し、深い階層を優先する。同階層ではoverrideを優先し通常版も保全する。追加資料は `requiredSources` で明示しGit refを完全SHAに固定する。作業ディレクトリのdirtyな指示と過去runは再実行の補足入力として保存する。

事前取得はUTF-8本文の実バイトを出典ごとに重複除外し、既定合計10 MiBを超えれば切り捨てず停止する。循環・不正応答・取得不能を「関係なし」に置き換えない。エージェントの追加調査にはこの予算やwatch一覧を制限として使わない。

`evaluateIssueEligibility` はrun/watch共通。open・enabled・単一ready・子なし・依存解消・開始資料取得を必要とし、担当者・優先度は条件にしない。依存はcompleted closeと最新の信頼できる成果報告・開始SHAへの必要コミット包含を要求する。証拠解析は `github-evidence.ts`。[機械可読書式と投稿者確認](specification.md)を使い、最新の不正証拠から古い有効証拠へ戻らない。人間の「成果コミット不要」は理由付きの専用書式で記録できる。

文脈と判定は `issue-context.json` / `dependency-evidence.json` に保存する。待機は無更新。通信・権限・不正応答を単なる待機へ変換して続行しない。

## 作業環境と再実行

`github-repository.ts` / `github-workspace.ts` / `github-workspace-store.ts` が、探索・明示認証通信・開始点・内容命名・対応記録・再利用を担当する。[詳細](github-workspace.md)を参照。

親なしは自身、子は同一repoの最上位親を管理単位とする。対応は `branches/<repositoryId>/<managementIssueId>.json` にだけ保存し、専用コメントを投稿しない。初回命名は最大3試行。後続子・タイトル変更・再実行で改名しない。後続子は公開済み共有成果から別worktreeを作る。

同Issueの再実行は、一意に特定した過去run chainの実worktreeを使い、index・dirty・未追跡・未pushコミットを保持する。新runと新Planで初回baseからの累積差分を検証・Reviewする。前runの成功やSDKセッションを再利用しない。記録と実物の矛盾・対象記録の破損・候補複数は推測修復しない。無関係な履歴の破損は警告として扱う。

並列起動のロック・PID確認は設けない。異常終了後の残存処理確認と成果の扱いは利用者が判断する。復旧前に記録・Gitオブジェクト/refs・全関連worktreeを一緒に保全する。

## Codexの呼び出しと認証境界

[専用ホーム](codex-home.md)を使う。Plan / Review / Reportは読み取り専用の新規thread。Implementation / Fix / Commitは採用Planのthreadを継続するが、フェーズごとに設定・ルール・権限を再適用する。GitHubのwrite認証は渡さず、専用read認証でghによる追加調査を許可する。MCPは空、ネットワークは有効。[認証分離](github-connection.md)を参照。

Plan / Reviewの内容変更、Implementation中の先行commit、不正JSON、スキーマ違反、SDK途中終了、保存失敗は停止する。SDK開始前の一時障害だけ、作業状態不変の確認後に最大2回再試行する。イベント受信後の障害や途中変更は自動再実行しない。無応答は警告を保存し、経過時間だけでは強制終了しない。

Planの調査で拒否されたコマンドがあっても、具体的な人間対応なしに計画・実装が不可能とは限らない。実行場所・根拠・未実行を記録し、発見した検証手順の必須性を維持してハーネスへ渡す。正式検証での権限不足は記録を保存して停止する。

## ハーネスによる検証実行

`src/verification.ts` の `verifyImplementation(control)` は、初回Implementationまたは
各Fixが成功した後に呼ぶ。同じcontrolの状態から試行番号1〜4を決め、保存済みPlanと
その回までのImplementation/Fixの追加・更新・削除を順に適用する。重複ID・存在しない更新対象・
新規入力の不整合は同じ実装threadの読み取り専用再提出で初回＋最大2回まで訂正する。必須確認の削除や弱体化は履歴に残してReviewへ渡す。

実行方式・コマンド許可リストの設定は持たない。Planでリポジトリの指示から発見した準備・検証を順に実行する。
`kind: "prepare"` は依存導入・コンテナ起動等の準備。`command` には必要なコンテナ操作も含め、
起動cwdはworktree内の相対パス、`executionMethod` は実行環境と対象runのコードを使う方法、`evidence` は根拠を示す。
間接実行では対象worktreeとの対応を確認するガードをcommandに含めるようエージェントへ指示する。
ハーネスにDocker専用の方式・自動検出器・独自sandboxは設けず、既存の権限範囲でそのコマンドを実行する。

worktree外のcwd・絶対パス・symlink脱出・存在しないcwdは理由付きskippedとして保存する。
認証・Git設定を子プロセスへ継承せず、PATHとLANGだけを渡す。stdinを閉じ、stdout/stderrは
流し読みし、秘密除外・65536文字の上限と省略理由を維持する。

各コマンドの開始・終了状態をstate/eventsへ保存し、終了結果を
`verification-N.command-I.json` に確定する（Iは0からの実行順）。全結果とログ、
検証後の累積差分、Review入力を既存保存APIで確定してからverification成功と最新成果物参照を保存する。
各結果の `execution` には実際のprogram・引数・起動cwdを保存する。
コマンド単位の成果物の破損もstatusで表示する。
`passed / failed / skipped`、未検出、根拠、累積更新履歴を保存済みReview入力へ含める。
追加の `outcome` で `passed / preparation_failed / verification_failed / permission_denied / not_run` を区別する（過去の記録では省略可）。
準備失敗では後続を未実施にしてReviewへ渡す。検証の非ゼロ終了は再試行せずReviewへ渡す。
起動エラーも理由付き未実施として保存。権限不足（EACCES/EPERM、終了126、非ゼロかつstderrの権限エラー）は
後続を未実施とし、検証結果・Review入力を保存して安全停止する。権限昇格・再試行・新規Review呼び出しは行わない。
汎用シェルなので外部ツールの障害もそのコマンドの終了コードと出力で記録し、Reviewが原因を調査する。
signal・結果不明・保存失敗は共通の安全停止へ渡す。途中成果とworktreeは保持する。

各手順は`/bin/sh -ec <command>`で実行し、単純コマンドの途中失敗を後続成功で隠さない。
`-e`でも条件式（`if`、`&&`、`||`）やpipeline途中の失敗はすべて検出できるわけではない。
発見する手順は原則一操作ずつに分け、必要なガードは`check || exit`等で非ゼロ終了を明示する。
意図的な`|| true`や出力だけを根拠に成功扱いにする手順を作らない。
権限不足による停止ではReview入力まで保存するが、新規Review・コミット・review提出へ進まない。

検証前後にコード・index・未追跡ファイル・履歴の指紋を照合するため、生成物はリポジトリの
既存ignore設定に従って管理する。対象コードの変更は安全停止する。保存した指紋と異なる状態での
Review/Fix開始もSDK呼び出し前に停止する。検証中のCodex開始・検証の並行実行はフェーズ状態で拒否する。
呼び出し側は `await verifyImplementation(...)` → `await phases.review(attempt)` の順に実行する。
検証実行の統合テストは開発コンテナ内の実worktree・実コマンド・実保存で行い、Codexはテストダブルを使う。
実GitHub・実Codex全工程の実施状況は[統合検証記録](validation.md)を参照。CLI既定runも同じ発見手順を実行する。

## 独立Review・コミット・提出

`reviewImplementation` は正式検証と累積差分を新規Reviewへ渡す。要件・指示・採用Plan、全Implementation/Fix、検証計画と変更履歴、未検出事項、正式結果、未追跡を含む累積diffを保存する。確認項目は実装の `src/schemas.ts` の `reviewChecklist` を参照でき、コードと同じリポジトリで管理する。

指摘はseverity・description・validationCommandIds・locationを持つ。必須検証のfailed/skippedには対象IDを参照するmajor以上の指摘が必要。未知/重複ID、不整合なReviewは停止する。要件不足や重要な未確認事項をminorへ落として合格にしない。初回Review＋Fix最大3回、Review最大4回。SDK通信再試行とは別に数える。

合格時のtreeと検証時の指紋を保存する。Commit前後で累積履歴・各変更パス・最終tree・未コミット変更・作業ブランチを照合する。レビュー前コミット、空commit、merge、履歴改変、ソース変更は認めない。変更不要の再実行は既存の成果を報告する。

`github-report.ts` が保存済みの検証・Review・Git事実をReport出力と結合する。`github-submission.ts` が成果refを期待旧SHA付きでFFし、開始時remote照合・通常push・事後SHA照合・一件投稿・review更新を順に行う。[提出と部分成功](submission.md)を参照。応答不明を盲目的に再送しない。

着手後の人間判断はblockedと理由・選択肢・推奨、技術障害はstopped。ローカル停止を先に確定し、GitHub反映不能もCLIに示す。レート制限中は追加照会・停止理由投稿を控える。途中成果・公開済みコミット・コメントは取り消さない。

## watch・診断・履歴と検証の限界

watchは全監視repoを取得・整列し、一件ずつ公開runを待つ。実行後は一覧再取得、blocked/stoppedで監視も停止する。Ctrl+Cは新規着手を止め、実行中の子runは別セッションで終了まで待つ。doctor/dry-runは読み取りだけで、clone/fetch・worktree・実行記録・モデル呼び出しを行わない。

history/status/showは設定・認証・外部接続なしで保存記録を読む。worktree削除後も読める部分を表示する。記録の更新・自動変換・復旧をしない。

検証の対応表と当日の結果は[統合検証記録](validation.md)。代役API/SDK、実ローカルGit、実GitHub、実モデルの結果を区別する。Web UIは持たない。
