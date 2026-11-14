import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "../helpers/acceptance.js";
import { verifyTerminalShow } from "../helpers/show-terminal.js";
import metadata from "../../package.json" with { type: "json" };
const binary = "/artifacts/harness-linux-x64";
for (const path of ["/workspace", "/app/src", "/app/dist", "/app/node_modules"]) await assert.rejects(access(path));
for (const name of ["node", "bun", "npm", "gh"]) assert.notEqual((await command("sh", ["-c", `command -v ${name}`], "/tmp")).code, 0);
const root = await mkdtemp("/tmp/harness-standalone-");
try {
  const env = { HOME: root, PATH: process.env.PATH, LANG: "C.UTF-8", HARNESS_GITHUB_READ_TOKEN: "reader-private", HARNESS_GITHUB_WRITE_TOKEN: "writer-private" };
  assert.equal((await command(binary, ["--version"], root, env)).stdout, metadata.version + "\n");
  assert.deepEqual(await readdir(root), []);
  const help = await command(binary, ["--help"], root, env); assert.equal(help.code, 0); assert.match(help.stdout, /外部依存/);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, github: {}, watch: { repositories: ["a/b"] } }));
  const report = await command(binary, ["--config", configPath, "doctor", "--json"], root, env);
  assert.equal(report.code, 1); assert.equal(JSON.parse(report.stdout).items.find((i: { id: string }) => i.id === "gh.version").status, "異常");
  assert.deepEqual(await readdir(root), ["config.json"]);
  const old = '{"github":{"unexpected":true}}'; await writeFile(configPath, old);
  const rejected = await command(binary, ["--config", configPath, "run", "a/b#1"], root, env);
  assert.equal(rejected.code, 2); assert.match(rejected.stderr, /schemaVersion: 2/); assert.equal(await readFile(configPath, "utf8"), old);
  assert.equal((await command(binary, ["run", "1"], root, env)).code, 2);
  for (const custom of [false, true]) for (const detail of [false, true]) await verifyTerminalShow(binary, [], custom, detail);
  console.log("成功: 単一バイナリversion/help・外部gh不在診断・不正設定/引数拒否・履歴show TUI・記録不変");
} finally { await rm(root, { recursive: true, force: true }); }
