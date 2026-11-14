import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

declare const HARNESS_COMPILED: boolean;

export class CodexPathError extends Error {
  constructor(detail: string) {
    super(`Codex CLI: ${detail}。HARNESS_CODEX_PATH に外部Codex CLIの実行可能な絶対パスを指定してください（SDK互換版: 0.162.1）。スクリプトの場合はshebangのランタイムも必要です。`);
    this.name = "CodexPathError";
  }
}

// SDKに渡す前に、読み取れるスクリプトのインタープリター欠落を案内する。
// 実行専用のネイティブファイルは読み取り権限を要求しない。
async function checkInterpreter(path: string): Promise<void> {
  let handle;
  try { handle = await open(path, "r"); } catch { return; }
  let line: string;
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
  } finally { await handle.close(); }
  if (!line.startsWith("#!")) return;
  const interpreter = line.slice(2).trim().split(/\s+/)[0];
  if (!interpreter) throw new CodexPathError("shebang のインタープリター指定が空です");
  try {
    if (!(await stat(interpreter)).isFile()) throw new Error();
    await access(interpreter, constants.X_OK);
  } catch { throw new CodexPathError("shebang のインタープリターが存在しないか実行できません。必要なランタイムを別途配置してください"); }
}

/** Node/Bunソース実行では従来のSDK同梱依存探索も最後に維持する。 */
export async function resolveCodexPath(env: NodeJS.ProcessEnv, compiled = typeof HARNESS_COMPILED !== "undefined" && HARNESS_COMPILED): Promise<string | undefined> {
  const explicit = env.HARNESS_CODEX_PATH;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new CodexPathError("HARNESS_CODEX_PATH は絶対パスが必要です");
    try {
      if (!(await stat(explicit)).isFile()) throw new Error();
      await access(explicit, constants.X_OK);
    } catch { throw new CodexPathError("指定したファイルが存在しないか、通常ファイルではないか、実行権限がありません"); }
    await checkInterpreter(explicit);
    return explicit;
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
    } catch { continue; }
    await checkInterpreter(candidate);
    return candidate;
  }
  if (compiled) throw new CodexPathError("PATH に実行可能なcodexが見つかりません");
  return undefined;
}
