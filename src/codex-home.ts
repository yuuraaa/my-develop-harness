import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const codexPhases = ["plan", "implementation", "fix", "review", "commit", "report"] as const;
export type CodexPhase = typeof codexPhases[number];

/** 秘密ファイルの内容やOS例外をメッセージに含めない。 */
export class CodexHomeError extends Error {
  constructor(message: string) { super(`Codexホーム: ${message}`); this.name = "CodexHomeError"; }
}

const referenceGit = ["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"];
export function initialRules(phase: CodexPhase): string {
  const rule = (pattern: string[], decision: "allow" | "forbidden") =>
    `prefix_rule(pattern=${JSON.stringify(pattern)}, decision=${JSON.stringify(decision)})`;
  const lines = [`# ${phase}: 初回値。編集は次のフェーズ起動から反映。`];
  lines.push(rule(["gh", "api", "--method", "GET"], "allow"));
  for (const command of ["auth", "config", "issue", "pr", "repo", "secret", "variable", "ssh-key", "gpg-key"]) lines.push(rule(["gh", command], "forbidden"));
  // branch / remote は変更用の引数も持つので、無引数の参照を初期allowにしない。
  for (const command of referenceGit) lines.push(rule(["git", command], "allow"));
  for (const command of ["push", "merge", "rebase", "reset", "checkout", "switch", "restore", "clean", "cherry-pick", "revert", "fetch", "pull", "branch", "remote", "config", "update-ref", "worktree", "init", "clone", "rm", "mv", "apply", "am", "stash", "tag", "notes", "update-index", "read-tree", "write-tree", "commit-tree", "symbolic-ref", "gc", "prune", "reflog"]) {
    lines.push(rule(["git", command], "forbidden"));
  }
  for (const command of ["add", "commit"]) lines.push(rule(["git", command], "forbidden"));
  lines.push(rule(["git", "commit", "--amend"], "forbidden"));
  if (phase !== "commit" && phase !== "report") {
    for (const prefix of [["docker", "info"], ["docker", "version"], ["docker", "compose", "ps"]]) lines.push(rule(prefix, "allow"));
  }
  if (phase === "implementation" || phase === "fix") {
    for (const command of ["up", "build", "exec", "run"]) lines.push(rule(["docker", "compose", command], "allow"));
  }
  return lines.join("\n") + "\n";
}

async function entry(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function regular(path: string) {
  const info = await entry(path);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new CodexHomeError(`${path} は通常ファイルにしてください。既存内容は変更していません。`);
  return info;
}

async function createFile(path: string, content: string) {
  if (await regular(path)) { await access(path, constants.R_OK); return; }
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await regular(path); }
}

/** 作成・修復を伴わない検査。認証内容は読み取らない。 */
export type HomeInspection = { id: string; status: "正常" | "警告" | "異常"; reason: string; remedy: string };
export async function inspectWritableDirectory(path: string): Promise<void> {
  let ancestor = path;
  while (!await entry(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("ancestor");
    ancestor = parent;
  }
  if (!(await stat(ancestor)).isDirectory()) throw new CodexHomeError("保存先または作成先の既存祖先がディレクトリではありません。");
  await access(ancestor, constants.R_OK | constants.W_OK | constants.X_OK);
}

async function inspectHomePath(home: string, userHome: string): Promise<void> {
  if (!isAbsolute(home) || !isAbsolute(userHome)) throw new CodexHomeError("ホームは絶対パスで指定してください。");
  // 未作成の子パスも、既存祖先のsymlinkを解決して通常ホーム内への別名を拒否する。
  let ancestor = home;
  const suffix: string[] = [];
  while (!await entry(ancestor)) { suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  const canonical = resolve(await realpath(ancestor), ...suffix);
  const usual = await entry(join(userHome, ".codex")) ? await realpath(join(userHome, ".codex")) : resolve(userHome, ".codex");
  if (canonical === usual || canonical.startsWith(usual + "/")) throw new CodexHomeError("普段使いの ~/.codex は指定できません。専用ホームを指定してください。");
  await inspectWritableDirectory(home);
}

export async function inspectCodexHome(options: { codexHome?: string; userHome?: string } = {}): Promise<HomeInspection[]> {
  const userHome = options.userHome ?? homedir();
  const home = options.codexHome ?? join(userHome, ".harness");
  const source = join(userHome, ".codex", "auth.json");
  const results: HomeInspection[] = [];
  const check = async (id: string, action: () => Promise<boolean>, remedy: string, creationDirectory = home) => {
    try {
      const present = await action();
      // 未作成を警告にできるのは、通常runで不足分を生成できる見込みがある場合だけ。
      if (!present) await inspectWritableDirectory(creationDirectory);
      results.push({ id, status: present ? "正常" : "警告", reason: present ? "存在・種類・必要権限を確認" : "初回起動時の生成対象が未作成（作成先の既存祖先の権限を確認）", remedy: present ? "不要" : "通常のrun開始時に生成されます。doctorは作成しません。" });
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = error instanceof CodexHomeError ? error.message
        : code === "ENOENT" ? "必要なファイルまたはリンク先が存在しません"
        : code === "EACCES" || code === "EPERM" ? "必要な読み取り・書き込み・探索権限がありません"
        : code === "ENOTDIR" ? "パスの途中にディレクトリ以外の項目があります"
        : "ファイルの種類・パス・権限を確認できません";
      results.push({ id, status: "異常", reason, remedy });
    }
  };
  await check("codex.auth-source", async () => {
    if (!(await stat(source)).isFile()) throw new CodexHomeError("認証元が通常ファイルではありません。");
    await access(source, constants.R_OK | constants.W_OK); return true;
  }, "通常のCodexでfile認証を準備し、~/.codex/auth.jsonとリンク先の読み書き権限を確認してください。");
  await check("codex.home", async () => { await inspectHomePath(home, userHome); return !!await entry(home); }, "専用ホームに絶対パスを指定し、通常の~/.codexと別の領域・既存祖先の権限を確認してください。");
  results[results.length - 1]!.reason += `（専用ホーム: ${home}）`;
  await check("codex.auth-link", async () => {
    const previous = await entry(join(home, "auth.json"));
    if (!previous) return false;
    if (!previous.isSymbolicLink() || resolve(home, await readlink(join(home, "auth.json"))) !== resolve(source)) throw new CodexHomeError("auth.jsonが通常ファイルまたは異なるリンクと衝突しています。");
    if (!(await stat(join(home, "auth.json"))).isFile()) throw new CodexHomeError("auth.jsonのリンク先が通常ファイルではありません。");
    return true;
  }, "専用ホームのauth.jsonの衝突・リンク先を確認し、必要なら既存ファイルを手動退避してください。");
  await check("codex.config", async () => {
    if (!await regular(join(home, "config.toml"))) return false;
    await access(join(home, "config.toml"), constants.R_OK); return true;
  }, "専用ホームのconfig.tomlを読み取り可能な通常ファイルにしてください。");
  await check("codex.rules-directory", async () => {
    const info = await entry(join(home, "rules")); if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new CodexHomeError("rulesが実ディレクトリではありません。");
    await access(join(home, "rules"), constants.R_OK | constants.X_OK); return true;
  }, "rulesを読み取り・探索可能な実ディレクトリにしてください。");
  for (const phase of codexPhases) await check(`codex.rules.${phase}`, async () => {
    const path = join(home, "rules", `${phase}.rules`);
    if (!await regular(path)) return false;
    await access(path, constants.R_OK); return true;
  }, `rules/${phase}.rulesを読み取り可能な通常ファイルにしてください。未作成の場合はrulesまたは作成先の既存祖先に読み書き・探索権限が必要です。`, join(home, "rules"));
  return results;
}

export async function initializeCodexHome(options: { codexHome?: string; userHome?: string } = {}) {
  const userHome = options.userHome ?? homedir();
  const home = options.codexHome ?? join(userHome, ".harness");
  const source = join(userHome, ".codex", "auth.json");
  if (!isAbsolute(home) || !isAbsolute(userHome)) throw new CodexHomeError("ホームは絶対パスで指定してください。");
  try {
    if (!(await stat(source)).isFile()) throw new Error();
    await access(source, constants.R_OK | constants.W_OK);
  } catch { throw new CodexHomeError(`${source} が欠落・リンク切れ、または読み書きできません。普段使いのCodexでログインし、ファイルとリンク先の権限を確認してください。`); }
  try {
    await inspectHomePath(home, userHome);
    const auth = join(home, "auth.json");
    const previous = await entry(auth);
    if (previous && (!previous.isSymbolicLink() || resolve(home, await readlink(auth)) !== resolve(source))) {
      throw new CodexHomeError(`${auth} が既存ファイルまたは異なるリンクと衝突しています。内容を確認して手動で退避してください。`);
    }
    // 衝突を先に調べ、既存設定へ書き込まない。
    await regular(join(home, "config.toml"));
    const rules = join(home, "rules");
    const previousRules = await entry(rules);
    if (previousRules && (!previousRules.isDirectory() || previousRules.isSymbolicLink())) throw new CodexHomeError(`${rules} は実ディレクトリにしてください。`);
    for (const phase of codexPhases) await regular(join(rules, `${phase}.rules`));
    await mkdir(home, { recursive: true, mode: 0o700 });
    await access(home, constants.R_OK | constants.W_OK | constants.X_OK);
    if (!previous) {
      try { await symlink(source, auth); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(auth)).isSymbolicLink() || resolve(home, await readlink(auth)) !== resolve(source)) throw error;
      }
    }
    await mkdir(rules, { recursive: true, mode: 0o700 });
    await createFile(join(home, "config.toml"), '# ハーネス専用。普段使いの設定は継承しない。\ncli_auth_credentials_store = "file"\n');
    for (const phase of codexPhases) await createFile(join(rules, `${phase}.rules`), initialRules(phase));
    return { home: await realpath(home), auth: source };
  } catch (error) {
    if (error instanceof CodexHomeError) throw error;
    throw new CodexHomeError(`${home} を初期化できません。ディレクトリ・設定の読み書き権限と既存リンクを確認してください。既存ファイルは上書きしません。`);
  }
}

export async function readPhaseSettings(home: string, phase: CodexPhase) {
  try {
    await regular(join(home, "config.toml"));
    await regular(join(home, "rules", `${phase}.rules`));
    return { config: await readFile(join(home, "config.toml"), "utf8"), rules: await readFile(join(home, "rules", `${phase}.rules`), "utf8") };
  } catch { throw new CodexHomeError(`${home} のconfig.tomlとrules/${phase}.rulesを読み取れるようにしてください。`); }
}
