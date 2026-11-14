import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { showSettingsSchema } from "./show-settings.js";

export class GitHubConfigError extends Error {
  constructor() { super("GitHub設定が不正です。schemaVersion: 2 の examples/github-config.example.json を用意し、明示した認証環境変数を設定してください。"); }
}
export const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
  .refine(v => ![".", ".."].includes(v.split("/")[1]!)).transform(v => v.toLowerCase());
const nonempty = z.string().refine(v => !/[\x00-\x1f\x7f]/.test(v)).transform(v => v.trim()).pipe(z.string().min(1));
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const path = nonempty.refine(v => !v.startsWith("/") && !v.includes("\\") && !v.split("/").some(p => p === ".." || !p));
const sources = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file"), path }),
  z.strictObject({ kind: z.literal("githubFile"), repository: repositoryNameSchema, ref: nonempty, path }),
  z.strictObject({ kind: z.literal("githubIssue"), repository: repositoryNameSchema, number: z.number().int().positive().safe() }),
]);
const labels = z.strictObject({
  enabled: nonempty.default("harness:enabled"), ready: nonempty.default("harness:ready"),
  running: nonempty.default("harness:running"), blocked: nonempty.default("harness:blocked"),
  stopped: nonempty.default("harness:stopped"), review: nonempty.default("harness:review"),
}).refine(v => new Set(Object.values(v).map(x => x.toLowerCase())).size === 6);
const overrides = z.strictObject({
  pushRemote: nonempty.refine(v => !v.startsWith("-")).default("origin"),
  requiredSources: z.array(sources).default([]),
});
export const githubConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  github: z.strictObject({
    writeTokenEnv: envName.default("HARNESS_GITHUB_WRITE_TOKEN"),
    readTokenEnv: envName.default("HARNESS_GITHUB_READ_TOKEN"),
    maxContextBytes: z.number().int().positive().safe().default(10485760),
    labels: labels.prefault({}),
  }).refine(v => v.writeTokenEnv !== v.readTokenEnv),
  repositories: z.record(z.string(), overrides).default({}).refine(v => {
    const names = Object.keys(v).map(k => repositoryNameSchema.safeParse(k));
    return names.every(n => n.success) && new Set(names.map(n => n.data)).size === names.length;
  }).transform(v => Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toLowerCase(), x]))),
  watch: z.strictObject({ repositories: z.array(repositoryNameSchema).default([])
    .refine(v => new Set(v).size === v.length) }).prefault({}),
  repository: z.strictObject({ searchRoots: z.array(nonempty).min(1).optional(), cloneRoot: nonempty.optional() }).optional(),
  execution: z.strictObject({ codexHome: nonempty.optional(), model: nonempty.optional() }).optional(),
  show: showSettingsSchema.optional(),
});
export type GitHubConfig = z.infer<typeof githubConfigSchema>;
export function parseGitHubConfig(value: unknown, file: string): GitHubConfig {
  const parsed = githubConfigSchema.safeParse(value);
  if (!parsed.success) throw new GitHubConfigError();
  const config = parsed.data;
  if (config.repository?.searchRoots) config.repository.searchRoots = config.repository.searchRoots.map(p => resolve(dirname(resolve(file)), p));
  if (config.repository?.cloneRoot) config.repository.cloneRoot = resolve(dirname(resolve(file)), config.repository.cloneRoot);
  return config;
}
export async function loadGitHubConfig(file = join(homedir(), ".harness", "config.json")): Promise<GitHubConfig> {
  try { return parseGitHubConfig(JSON.parse(await readFile(file, "utf8")), file); }
  catch { throw new GitHubConfigError(); }
}
export function githubTokens(config: GitHubConfig, env: NodeJS.ProcessEnv = process.env): { read: string; write: string } {
  const read = env[config.github.readTokenEnv], write = env[config.github.writeTokenEnv];
  if (!read?.trim() || !write?.trim() || read === write || /[\r\n\x00]/.test(read + write)) throw new GitHubConfigError();
  return { read, write };
}
