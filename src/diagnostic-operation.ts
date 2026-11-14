/** doctor専用。生の例外や通信内容を表示しない。 */
export class DiagnosticTimeout extends Error {
  constructor() { super("操作が10秒でタイムアウトしました"); }
}

export async function diagnosticOperation<T>(action: () => Promise<T>, cancel: () => void, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { cancel(); } catch { /* 中止失敗でも診断を継続する。 */ }
        reject(new DiagnosticTimeout());
      }, milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
