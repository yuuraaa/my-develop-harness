# GitHub接続と認証分離

現行CLIはGitHub専用。[設定例](../examples/github-config.example.json)を
`loadGitHubConfig`で読み込む。
[実接続の準備](github-live-validation.md)を参照。

## 実行環境の準備

実行環境にGit・外部Codex CLIとGitHub CLIの`gh`を配置する。ghは通常ビルド・単一バイナリ・
開発イメージに同梱しない。[公式インストール手順](https://github.com/cli/cli#installation)を使い、
実行環境のPATHから`gh --version`が起動できることを確認する。
`GitHubClient.checkExecutable()`は存在と実行可否の検査であり、権限の充足は保証しない。

GitHubの認証は別々のトークンで準備する。

| 用途 | 環境変数の既定名 | 必要なリポジトリ権限 |
|---|---|---|
| ハーネスのAPI・Git通信 | HARNESS_GITHUB_WRITE_TOKEN | Issues read/write、Contents read/write、Metadata read |
| エージェントの追加調査 | HARNESS_GITHUB_READ_TOKEN | Issues read、Contents read、Metadata read |

トークンは実行元の秘密管理から環境変数で注入する。JSON・`.env`のコミット・コマンド引数・
remote URLへ値を書かない。設定には環境変数名だけを書く。読み書きの名前・値が同一、空、改行を含む場合は拒否する。
読み取り専用であることは発行時のGitHub権限で保証する。文字列が異なるだけではトークンの実権限は証明できない。
Codexへ継承するOpenAI用APIキー・PATH・HOME等について、書き込みtokenの環境変数名との衝突や
値への書き込みtokenの混入を、SDKや専用ホームを初期化する前に拒否する。認証の別名からも書き込み値を渡さない。
エージェントの可視範囲はこの読み取り認証の権限による。watch一覧や事前取得の10 MiBを追加調査の上限にしない。

設定はschemaVersion 2とgithubを必須とし、全階層で未知キーを拒否する。不正な値には設定例を示すエラーを返す。
repo名・watchは大小文字を正規化し重複を拒否する。未登録repoにも既定のorigin・追加資料なしを適用でき、
watchとローカル探索は独立している。searchRoots/cloneRootの相対値は設定ファイル所在基準。
資料のGit ref固定・symlink検査は文脈取得層の責務。

## 子プロセスの境界

APIはシェルを介さず`gh api --hostname github.com`を使う。更新JSONはstdinへ渡す。
用途に応じたトークン一つだけを`GH_TOKEN`に設定し、既存GH_TOKEN/GITHUB_TOKEN、SSH_AUTH_SOCK、
Git認証用環境変数、プロキシ等を継承しない。空の専用HOME/XDG_CONFIG_HOME/GH_CONFIG_DIRを用意し、
ghの既存ログイン・keyring設定を参照しない。環境変数を使う根拠は[gh公式資料](https://cli.github.com/manual/gh_help_environment)。

Git通信は`runAuthenticatedGit`を使い、確認済みrepoから作ったHTTPS URLへclone/fetch/pushする。
操作時だけ専用トークンを環境へ渡す固定credential helperを利用する。
helperはHTTPSのgithub.comへのgetだけに応答し、store/eraseでは保存しない。HTTPリダイレクトも無効化する。トークンはURL/argv/ファイルへ書かない。
グローバル・システムGit設定を無効にし、helper・extraHeaderを空にした上で専用helperを追加する。
対話・SSH・hooksを無効化し、repoローカルのcredential/http/URL書換え/include/askpass/sshCommand設定は拒否する。
URL文字列自体をremote名にしたrepo/worktree設定も拒否し、Gitによる宛先の別remoteへの解決を防ぐ。
Git通信の許可プロトコルはHTTPSだけに固定する。
必要なら人間が当該設定を確認して整理する。自動で設定を書き換えない。
remote URL・pushurl・URL書換えの宛先照合とref/fast-forward確認は作業環境・成果提出層の責務。
pushは`<source>:refs/heads/<branch>`の一つの明示refを必須とし、暗黙のref選択・削除・wildcardを拒否する。
サブモジュール再帰・followTags・mirror・pruneをコマンドで無効化し、ローカル設定で未指定のrepo/refを更新しない。

CodexのGitHub接続には`createCodexConnection({github, ...})`を使う。
空の専用HOMEに読み取りGH_TOKENだけを渡し、MCPテーブルを空にし、ネットワークを有効にする。
shell_environment_policyも固定し、読み取りgh環境をシェルへ継承させる。OpenAI用APIキーはシェル継承から外す。
`execution.gitIdentity`指定時は作成者・コミッターの4環境変数もCodexとそのシェルへ渡す。
書き込みtokenの値の混入と環境変数名の衝突は初期化前に拒否する。[設定手順](usage.md#共通のgit作成者情報)を参照。
トークンをconfig.tomlや.rulesに書かない。初期ルールは`gh api --method GET`を許可し、
auth/config/issue/pr等の操作は禁止する。既存.rulesは自動更新しないため、内容を確認する。

正式検証にも空のHOMEと認証なし環境を渡す。既存認証設定を拒否し、ローカルファイルへのURL転送だけは許可する。
準備・検証コマンドは既存OS権限で実行するため、Dockerソケット・任意ファイル参照等を使うコードまで隔離する機構ではない。
外部コンテナ自身にマウントされた認証や任意スクリプトが設定を上書きする操作は、この環境分離だけでは防げない。
トークンを作業先や検証用コンテナへマウントしない運用が必要。
空の認証ディレクトリは調査のため残すが、秘密は保存しない。停止後に不要なものを手動整理できる。

## 通信・記録の契約

`getPages()`はLinkのnextを追い全ページを返す。外部ホスト・循環・非配列を拒否し、切り捨てない。
対象repoの制限や文脈総量検査はこの接続層に設けず、文脈取得層で適用する。
ghのオプションは[公式APIマニュアル](https://cli.github.com/manual/gh_api)に基づく。

読み取りの一時障害のみ初回＋最大2回、1秒・2秒の待機を挟む。認証・権限・設定・不正応答は即時停止。
Git fetchも既知の一時通信失敗だけを同じ回数で再試行する。cloneの部分作成とpushは再送しない。
更新の通信切断・5xx・成功ヘッダー後の異常終了・ヘッダー/JSON不正・キャンセルはunknownとし、利用側のreconcileへ渡す。
照合で成功確認できた場合だけ成功を返し、確認不能・照合失敗は停止する。同じ更新を単純再送しない。
gh終了コード2はキャンセルであり、GETではcancelledとして再試行せず停止する。

403/429のレート制限は権限拒否と区別し、Retry-AfterまたはresetからretryAtを算出する。
時刻が得られなければnullとし推測せず、その場で停止する。`record`は各失敗のkind/attempt/retryAtだけを受け取る。
`githubRunRecorder(store, phase)`でfsync付きrunイベントへ保存でき、保存失敗では追加通信せず停止する。
利用フローはこのcallbackをrunの保存へ接続すること。
runの状態と停止を記録する。停止後に別の投稿・再照会を行うかも利用側で制御する。
APIの操作固有の成功照合・ラベル遷移・push結果SHA照合は [提出処理](submission.md) とGitHubControlが管理する。

生stderr・プロセス例外・認証ヘッダー・入力JSONを診断へ返さない。成功本文とGit出力も注入した認証値を除外する。
利用側が独自に出力を保存する際は`githubTokens`で解決した読み書き両値をRunStoreのsecretsにも登録する。
認証環境・プロセス引数オブジェクト自体をログへ書いてはいけない。

## 検証範囲

tests/github.test.tsで設定・ページ分割・再試行・制限時刻callback・応答不明・秘密除外を検証する。
実プロセスのgh代役、実Gitのcredential fill/approveとrepoローカル設定拒否を含む。
tests/codex.test.tsで全6フェーズのSDK入力・読み取り認証・ネットワーク・MCP分離を確認する。
tests/verification.test.tsの実コマンド検証も継続する。
実GitHubの分離認証・親子依存API・投稿者権限照会・push/投稿、実モデルによる自律調査は未検証。
専用非公開repoを使う[実接続検証](github-live-validation.md)を参照。
