import { spawn } from "node:child_process";
export async function command(file: string, args: string[], cwd: string, env = process.env) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, signal: AbortSignal.timeout(50_000) });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    let error: Error | undefined;
    child.on("error", value => { error = value; });
    child.on("close", code => { if (error) reject(error); else resolve({ code, stdout, stderr }); });
  });
}
