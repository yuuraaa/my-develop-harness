import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "bun:test";
import { codexPhases, initializeCodexHome } from "../src/codex-home.js";

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-home-")); temporary.push(root);
  await mkdir(join(root, ".codex"));
  const source = join(root, ".codex", "auth.json");
  await writeFile(source, '{"fixture":1}', { mode: 0o600 });
  const home = join(root, ".harness");
  return { root, source, home, init: () => initializeCodexHome({ userHome: root }) };
}

describe("ハーネスCodexホーム", () => {
  it("初回配置・認証共有・再初期化とユーザー編集の保存", async () => {
    const f = await fixture();
    await writeFile(join(f.root, ".codex", "config.toml"), "通常設定はコピー禁止");
    await f.init();
    expect(await readlink(join(f.home, "auth.json"))).toBe(f.source);
    expect(await readFile(join(f.home, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
    expect((await readdir(join(f.home, "rules"))).sort()).toEqual(codexPhases.map(x => `${x}.rules`).sort());
    await writeFile(join(f.home, "config.toml"), 'model = "user-choice"\n');
    await writeFile(join(f.home, "rules", "fix.rules"), "# ユーザー編集\n");
    await f.init();
    expect(await readFile(join(f.home, "config.toml"), "utf8")).toBe('model = "user-choice"\n');
    expect(await readFile(join(f.home, "rules", "fix.rules"), "utf8")).toBe("# ユーザー編集\n");
    await writeFile(join(f.home, "auth.json"), '{"fixture":2}');
    expect(await readFile(f.source, "utf8")).toBe('{"fixture":2}');
    expect((await lstat(join(f.home, "auth.json"))).isSymbolicLink()).toBe(true);
    await writeFile(f.source, '{"fixture":3}');
    expect(await readFile(join(f.home, "auth.json"), "utf8")).toBe('{"fixture":3}');
    await rm(f.source); await writeFile(f.source, '{"fixture":4}');
    expect(await readFile(join(f.home, "auth.json"), "utf8")).toBe('{"fixture":4}');
  });

  it.each(["missing", "dangling", "permission"])("認証元の異常で既存設定を作らない: %s", async mode => {
    const f = await fixture();
    await rm(f.source);
    if (mode === "dangling") await symlink(join(f.root, "missing.json"), f.source);
    if (mode === "permission") await writeFile(f.source, "fixture", { mode: 0o000 });
    try {
      await expect(f.init()).rejects.toThrow("欠落・リンク切れ、または読み書きできません");
      await expect(lstat(f.home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (mode === "permission") await chmod(f.source, 0o600); }
  });

  it.each(["file", "other-link", "broken-link"])("認証の衝突を上書きしない: %s", async mode => {
    const f = await fixture(); await mkdir(f.home);
    const auth = join(f.home, "auth.json");
    if (mode === "file") await writeFile(auth, "既存認証");
    else await symlink(join(f.root, mode === "broken-link" ? "missing" : ".codex"), auth);
    await expect(f.init()).rejects.toThrow("衝突");
    if (mode === "file") expect(await readFile(auth, "utf8")).toBe("既存認証");
    else expect(await readlink(auth)).toBe(join(f.root, mode === "broken-link" ? "missing" : ".codex"));
    await expect(lstat(join(f.home, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("正しい相対リンクを保持する", async () => {
    const f = await fixture(); await mkdir(f.home);
    await symlink("../.codex/auth.json", join(f.home, "auth.json"));
    await f.init();
    expect(await readlink(join(f.home, "auth.json"))).toBe("../.codex/auth.json");
  });

  it("通常ホームとその別名を拒否する", async () => {
    const f = await fixture();
    await expect(initializeCodexHome({ codexHome: join(f.root, ".codex"), userHome: f.root })).rejects.toThrow("指定できません");
    const alias = join(f.root, "alias"); await symlink(join(f.root, ".codex"), alias);
    await expect(initializeCodexHome({ codexHome: alias, userHome: f.root })).rejects.toThrow("指定できません");
  });

  it("設定リンクやrulesディレクトリの衝突を拒否する", async () => {
    const f = await fixture(); await mkdir(f.home);
    await symlink(f.source, join(f.home, "config.toml"));
    await expect(f.init()).rejects.toThrow("通常ファイル");
    expect(await readFile(f.source, "utf8")).toBe('{"fixture":1}');
    await rm(join(f.home, "config.toml"));
    await writeFile(join(f.home, "rules"), "keep");
    await expect(f.init()).rejects.toThrow("実ディレクトリ");
    expect(await readFile(join(f.home, "rules"), "utf8")).toBe("keep");
  });

  it("ホームの書き込み権限不足を案内する", async () => {
    const f = await fixture(); await mkdir(f.home); await chmod(f.home, 0o500);
    try { await expect(f.init()).rejects.toThrow("読み書き権限"); }
    finally { await chmod(f.home, 0o700); }
    expect(await readdir(f.home)).toEqual([]);
  });

  it("実CLI 0.162.1のファイル保存でリンクを維持する（ダミーAPIキー・通信なし）", async () => {
    const f = await fixture(); await f.init();
    const cli = resolve("node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
    await new Promise<void>((ok, fail) => {
      const child = execFile(cli, ['-c', 'cli_auth_credentials_store="file"', 'login', '--with-api-key'],
        { env: { PATH: process.env.PATH, HOME: f.root, CODEX_HOME: f.home } }, error => error ? fail(new Error("ダミー認証保存に失敗")) : ok());
      child.stdin!.end("fixture-key-without-credentials\n");
    });
    expect(JSON.parse(await readFile(f.source, "utf8")).OPENAI_API_KEY).toBe("fixture-key-without-credentials");
    expect((await lstat(join(f.home, "auth.json"))).isSymbolicLink()).toBe(true);
  });

  it("実CLIで全フェーズのgit commit/add・Docker・履歴操作の初期ルールを照合する", async () => {
    const f = await fixture(); await f.init();
    for (const phase of codexPhases) {
      const rules = join(f.home, "rules", `${phase}.rules`);
      for (const command of [["git", "commit", "-m", "fixture"], ["git", "add", "a"], ["git", "push"], ["git", "reset", "--hard"], ["docker", "compose", "exec", "dev", "npm", "test"], ["gh", "api", "--method", "GET", "/repos/example/product"], ["gh", "auth", "login"]]) {
        const { stdout } = await promisify(execFile)(resolve("node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"), ["execpolicy", "check", "--rules", rules, "--", ...command]);
        const result = JSON.parse(stdout);
        const decision = command[0] === "gh" ? command[1] === "api" ? "allow" : "forbidden"
          : command[0] === "docker" ? ["implementation", "fix"].includes(phase) ? "allow" : undefined
          : "forbidden";
        if (decision) expect(result.decision).toBe(decision);
        else expect(result.matchedRules).toEqual([]);
      }
    }
  });
});
