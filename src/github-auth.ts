import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubConfigError } from "./github-config.js";

/** 認証値・生のプロセスエラーを返さない。stdinもログへ渡さない。 */
export type GitHubProcess = (program: string, args: string[], env: Record<string, string>, input?: string, cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export const githubProcess: GitHubProcess = (program, args, env, input, cwd) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { env, ...(cwd ? { cwd } : {}), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => { /* 早期終了はcloseの終了コードで判定する。 */ });
  child.on("error", () => reject(new GitHubConfigError()));
  child.on("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  child.stdin.end(input);
});

/** 空ホームは保持するが、認証値を書かない。既存gh/keyring/SSH/Git環境を継承しない。 */
export async function isolatedGitHubEnvironment(source: NodeJS.ProcessEnv = process.env, root?: string): Promise<Record<string, string>> {
  const home = await mkdtemp(join(root ?? tmpdir(), "harness-auth-"));
  await mkdir(join(home, "gh"), { mode: 0o700 });
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: home,
    XDG_CONFIG_HOME: home, GH_CONFIG_DIR: join(home, "gh"), GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GIT_SSH_COMMAND: "/bin/false",
    GIT_CONFIG_COUNT: "5", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.extraHeader", GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "credential.interactive", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.hooksPath", GIT_CONFIG_VALUE_3: "/dev/null",
    GIT_CONFIG_KEY_4: "http.followRedirects", GIT_CONFIG_VALUE_4: "false",
  };
}

/** repoローカルの別認証・URL書換えを拒否。設定値はエラーへ載せない。 */
export async function checkRepositoryCredentials(cwd: string, env: Record<string, string>, run: GitHubProcess = githubProcess, allowLocalFileRewrites = false): Promise<void> {
  for (const scope of ["--local", "--worktree"]) {
    let result;
    try {
      if (scope === "--worktree") {
        const enabled = await run("git", ["config", "--local", "--bool", "--get", "extensions.worktreeConfig"], env, undefined, cwd);
        if (enabled.code === 1 || enabled.code === 0 && enabled.stdout.trim() === "false") continue;
        if (enabled.code !== 0 || enabled.stdout.trim() !== "true") throw new GitHubConfigError();
      }
      // GitはURL文字列も同名remoteとして解決する。origin等の通常remoteと区別してURL名を拒否する。
      result = await run("git", ["config", scope, "--name-only", "--get-regexp", "^(credential\\.|http\\.|url\\.|core\\.sshcommand|core\\.askpass|include|remote\\.https?://)"], env, undefined, cwd);
    }
    catch { throw new GitHubConfigError(); }
    if (result.code === 1) continue;
    // 認証なしの検証ではローカルbare等への転送だけ許可できる。外部URL/認証への転送は拒否。
    if (result.code === 0 && allowLocalFileRewrites && result.stdout.trim().split(/\r?\n/).every(k => /^url\.\/[^\x00-\x1f]+\.(?:insteadof|pushinsteadof)$/i.test(k))) continue;
    throw new GitHubConfigError();
  }
}

/** HTTPSの確定宛先を渡す。remote/refの照合・push結果照合は利用側の責務。 */
export async function runAuthenticatedGit(options: {
  operation: "clone" | "fetch" | "push" | "ls-remote"; repository: string; token: string;
  cwd: string; refs?: string[]; destination?: string; env?: NodeJS.ProcessEnv; run?: GitHubProcess;
  record?: (event: import("./github.js").GitHubRecord) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  reconcile?: () => Promise<{ confirmed: boolean }>;
}): Promise<{ stdout: string }> {
  const { repositoryNameSchema } = await import("./github-config.js");
  const parsed = repositoryNameSchema.safeParse(options.repository);
  if (!parsed.success || !options.token.trim() || /[\r\n\x00]/.test(options.token)) throw new GitHubConfigError();
  const refs = options.refs ?? [];
  if (refs.some(v => !v || /^[+-]/.test(v) || /[\x00-\x20\x7f]/.test(v))) throw new GitHubConfigError();
  if (options.operation === "clone" && (!options.destination || refs.length)) throw new GitHubConfigError();
  // push.default等に選択を委ねず、一つの明示ブランチだけを更新する。削除・wildcardも許可しない。
  if (options.operation === "push" && (refs.length !== 1 || !/^[^:*]+:refs\/heads\/[^:*]+$/.test(refs[0]!))) throw new GitHubConfigError();
  const env = await isolatedGitHubEnvironment(options.env);
  const run = options.run ?? githubProcess;
  if (options.operation !== "clone") await checkRepositoryCredentials(options.cwd, env, run);
  // helperは固定プログラム。秘密はプロセス環境だけに置き、URL/argv/ファイルには保存しない。
  env.HARNESS_GIT_TOKEN = options.token;
  env.GIT_ALLOW_PROTOCOL = "https";
  env.GIT_CONFIG_COUNT = "6";
  env.GIT_CONFIG_KEY_5 = "credential.helper";
  env.GIT_CONFIG_VALUE_5 = "!f() { protocol=; host=; while IFS= read -r line && test -n \"$line\"; do case \"$line\" in protocol=*) protocol=${line#protocol=};; host=*) host=${line#host=};; esac; done; if test \"$1\" = get && test \"$protocol\" = https && test \"$host\" = github.com; then printf '%s\\n' 'username=x-access-token' \"password=$HARNESS_GIT_TOKEN\"; fi; }; f";
  const url = `https://github.com/${parsed.data}.git`;
  const args = options.operation === "ls-remote" ? ["ls-remote", "--symref", "--", url, ...refs]
    : options.operation === "clone" ? ["clone", "--", url, options.destination!]
    : [options.operation, ...(options.operation === "push" ? ["--porcelain", "--recurse-submodules=no", "--no-follow-tags", "--no-mirror", "--no-prune"] : ["--no-tags", "--no-recurse-submodules"]), "--", url, ...refs];
  const { GitHubError } = await import("./github.js");
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result;
    try { result = await run("git", args, env, undefined, options.cwd); }
    catch { throw new GitHubConfigError(); }
    if (result.code === 0) return { stdout: result.stdout.split(options.token).join("[REDACTED]") };
    const denied = /authentication failed|could not read username|403|401|permission denied|repository not found/i.test(result.stderr);
    const transient = /could not resolve host|failed to connect|connection (?:reset|timed out)|HTTP (?:code = |error: )?50[0234]|remote end hung up/i.test(result.stderr);
    const failure = new GitHubError(denied ? "permission" : options.operation === "push" ? "unknown" : transient ? "transport" : "request");
    await options.record?.({ kind: failure.kind, attempt, retryAt: null });
    if (failure.kind === "unknown" && options.reconcile && (await options.reconcile()).confirmed) return { stdout: "" };
    // cloneは部分作成を保持。pushは操作固有の照合に委ね、再送しない。
    if (!["fetch", "ls-remote"].includes(options.operation) || failure.kind !== "transport" || attempt === 3) throw failure;
    await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1000 * attempt);
  }
  throw new GitHubError("transport");
}
