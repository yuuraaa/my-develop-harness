# 専用非公開repoでの実接続検証手順


## 実施対象と許可を確定する

専用の非公開リポジトリを用意する。製品repoや既存の実業務Issueは検証対象にしない。実行前に、対象repo・実行環境・下記の操作範囲について利用者の許可を得る。

| 操作 | 許可対象の具体例 |
|---|---|
| repo準備 | 必要な場合のみ専用private repoを1件作り、mainへ最小fixtureと指示・テストを投入する。既存専用repoの利用なら新規作成不要 |
| Issue/ラベル/関係 | 許可なしIssue、親、子A/子Bの4件と6ラベルを作成し、親に子A/子Bを登録、子Bを子Aに依存させる。再実行用のready復帰と依存検証用の子A completed closeは人間が行う |
| ハーネス実行 | 子Aの小変更と後続子B、同Issue再実行。管理単位から命名した成果branchへ通常FF pushし、各runの成果コメント1件と状態ラベル更新を行う。停止時にはstopped/blockedと必要な理由投稿があり得る |
| 保持 | 検証repo・Issue・成果branch・run記録を残す。PR作成・merge・repo削除・履歴改変は実施しない |

この計画だけでは外部操作を許可されたものと扱わない。ハーネスがIssueをcloseする工程はなく、依存の完了承認は人間に依頼する。認証の発行・追加権限・リポジトリ作成用の管理権限は別途準備する。

## 環境・権限の準備

- ハーネスの実行環境にBun（通常版のみ）・Git・sh・CA証明書・gh・SDK互換ネイティブCodex CLIを配置する。[通常/単一バイナリ](standalone.md)は同じ外部認証条件を使う。開発用devにはgh/Codex/認証が自動配置されない。
- 新しい専用の実行ユーザーHOMEと保存領域を用意し、本番 `~/.harness` と混ぜない。通常版はビルド済み `bun /absolute/dist/index.js`、単一版は絶対パスの実行ファイルを使う。元clone/common directoryとworktreeが実行環境内で同じ絶対パスから読めることを確認する。
- write側は対象repoだけにIssues read/write・Contents read/write・Metadata read、read側はIssues read・Contents read・Metadata readを付けた異なるトークンを発行する。別名の同一値を使わない。repo作成や設定変更の認証をCodexへ渡さない。
- トークンは秘密管理から既定の `HARNESS_GITHUB_WRITE_TOKEN` / `HARNESS_GITHUB_READ_TOKEN` へ注入し、値・環境一覧・HTTPヘッダー・生ログをチャットやリポジトリへ保存しない。既存ghログインやSSH agentを代用しない。
- Codex認証は[専用ホーム手順](codex-home.md)で準備する。認証を対象コードや検証用コンテナへマウントしない。必要なコンテナ操作権限は事前設定し、途中で無断昇格しない。

GitHubの[親子API](https://docs.github.com/en/rest/issues/sub-issues)と[依存API](https://docs.github.com/en/rest/issues/issue-dependencies)はIssues権限を使う。[投稿者権限照会](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)もwrite側で実測し、不可なら依存証拠判定を省略しない。全APIは製品と同じ明示バージョン・媒体型を使う。

## fixtureと観測項目

最小fixtureは `message.txt` の `hello` を `hello github` へ変える小変更とし、Bunの検査を一件置く。README/AGENTS.mdには実行環境と検証コマンドを記載し、Planが対象worktreeから発見できるようにする。コンテナから検証する場合は対象worktreeの実パス/マウントを照合するガードを含める。子Aの本文には変更・テスト成功・PR/close/merge禁止を明記し、子Bは既存成果の確認のみで変更不要でもよい。

初期ラベルは、許可なしIssueに `harness:ready` のみ、親・子A・子Bに `harness:enabled` と `harness:ready` の両方を付ける。全件open、親だけが直接子を持ち、子Bだけが子Aに依存する。これにより親除外と依存待ちを許可不足と区別する。子A/子Bには保持確認用の無関係ラベルも付ける。

専用設定は[設定例](../examples/github-config.example.json)のrepo・探索先・cloneRootを確定値へ手動変更し、executionを指定する。watchはこの専用repoだけにする。以下の例は `harness` がその設定・保存HOMEで起動することを前提とし、`OWNER/REPO#番号` を実物に置き換える。

1. write/read各認証で、repoがprivateでID/名前が一致すること、Issue・コメント全ページ、子Aの親、親のsub_issues、子Bのblocked_byをGETして確認する。親なしIssueはIssue本体の `parent_issue_url` と `/parent` の応答を記録する。404だけで「親なし」と断定しない。応答に必要フィールドがなければ、現行コードとの不整合を直すまでrunしない。
2. `harness doctor 'OWNER/REPO#子A' --repo /absolute/clone --json` と `harness watch --dry-run`。write側のユーザー照会・投稿者権限照会・必要ラベル・資料・remoteを確認し、前後のGit/Issue/保存領域に更新がないことを確認する。read側は権限設定画面でreadのみを確認する。単なるGET成功で読み取り専用を証明しない。
3. 許可なしIssueと親Issueはrunで非着手、子Bは依存待ちで非着手。running/コメント/worktree/モデル呼び出しが生じないことを確認する。watchは待機理由を表示し、待機だけで投稿しない。
4. 子Aの `harness run` を実Codexで実行する。Planの管理単位と内容命名、実装thread継続、正式検証の終了0、独立Review thread、レビュー後commit、通常FF push、成果コメント1件、enabledと無関係ラベルの保持、単一reviewを確認する。stateだけでなくremote完全SHAとレビュー済みtreeを照合する。
5. 子Aはreviewの間、子Bの依存待ちが続く。人間が子Aの成果を確認してcompleted closeした後、子Bを実行する。保存された最新の成果マーカー・投稿者権限・開始点への必要SHA包含を確認する。同じ管理単位branchを使い、名前を再生成しない。
6. 人間が子Bをreadyに戻し再実行する。新run・新Plan・新検証・独立Review、保存された実worktree再利用、過去run不変、変更不要時の空commit/重複pushなし、新runの成果コメント1件を確認する。初回baseからの累積差分をReviewへ渡す。
7. 認証分離は `tests/codex.test.ts` のSDK境界試験に加え、実Codexに「GH_TOKEN等の値を出力せずread認証で対象GETができ、write環境変数は存在しない」ことを追加調査させる。正式検証も値を表示せず認証環境が存在しないことを検査する。権限の実態はトークン発行設定と合わせて確認する。
8. 同じ小変更の実績が通常版か単一バイナリかを記録する。一方だけの成功で両方の実モデル全工程成功としない。障害注入は代役テストで行い、実repoへの権限外操作・レート制限の意図的消費・force pushは行わない。

各項目に実施日時、実行主体、repo/Issue URL、CLI/gh/Codex版、run ID、branch・base/head完全SHA、各段階の結果、コメントID/URL、ラベル集合、成果場所、未検証を記録する。PRが作られていないこと、ハーネスによるclose/mergeがないことも確認する。
