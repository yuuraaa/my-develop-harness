import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "bun:test";
import { resolveCodexPath } from "../src/codex-path.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it("外部CLIの絶対パスを優先し、PATHの実行可能ファイルを順番に探索する", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-path-")); roots.push(root);
  const first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, "codex"), "", { mode: 0o600 });
  await writeFile(join(second, "codex"), "", { mode: 0o700 });
  expect(await resolveCodexPath({ PATH: `${first}:${second}` }, true)).toBe(join(second, "codex"));
  await chmod(join(first, "codex"), 0o700);
  expect(await resolveCodexPath({ PATH: `${first}:${second}` }, true)).toBe(join(first, "codex"));
  expect(await resolveCodexPath({ PATH: first, HARNESS_CODEX_PATH: join(second, "codex") }, true)).toBe(join(second, "codex"));
  await expect(resolveCodexPath({ PATH: second, HARNESS_CODEX_PATH: join(root, "missing") }, true)).rejects.toThrow("実行権限");
  await expect(resolveCodexPath({ HARNESS_CODEX_PATH: first }, true)).rejects.toThrow("通常ファイル");
  await expect(resolveCodexPath({ HARNESS_CODEX_PATH: "codex" }, true)).rejects.toThrow("絶対パス");
  const script = join(root, "missing-interpreter");
  await writeFile(script, "#!/missing/interpreter\n", { mode: 0o700 });
  await expect(resolveCodexPath({ HARNESS_CODEX_PATH: script }, true)).rejects.toThrow("インタープリター");
});
it("コンパイル版は外部CLI不在を案内し、従来起動はSDK既定探索を維持する", async () => {
  expect(await resolveCodexPath({}, false)).toBeUndefined();
  await expect(resolveCodexPath({}, true)).rejects.toThrow("HARNESS_CODEX_PATH");
});
