import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ShowArgumentError } from "./show-error.js";

// 名前付きキーか、修飾なしの印字可能な単一文字。ページ移動は割り当てない。
const key = z.string().refine(value => ["up", "down", "tab", "escape", "enter", "space"].includes(value)
  || [...value].length === 1 && !/[\s\p{C}\p{M}]/u.test(value), "キーはup/down/tab/escape/enter/spaceまたは印字可能な単一文字を指定してください");
export const defaultShowKeys = { up: "up", down: "down", toggle: "tab", quit: "q" } as const;
export const showSettingsSchema = z.strictObject({
  keys: z.strictObject({ up: key.optional(), down: key.optional(), toggle: key.optional(), quit: key.optional() }).optional(),
  colors: z.strictObject({ border: z.string().regex(/^#[\da-f]{6}$/i).optional(), activeBorder: z.string().regex(/^#[\da-f]{6}$/i).optional() }).optional(),
}).refine(value => new Set([
  value.keys?.up ?? defaultShowKeys.up, value.keys?.down ?? defaultShowKeys.down,
  value.keys?.toggle ?? defaultShowKeys.toggle, value.keys?.quit ?? defaultShowKeys.quit,
]).size === 4, "操作キーが重複しています");
export type ShowSettings = z.infer<typeof showSettingsSchema>;
export function resolveShowSettings(value: ShowSettings = {}) {
  return {
    keys: {
      up: value.keys?.up ?? defaultShowKeys.up,
      down: value.keys?.down ?? defaultShowKeys.down,
      toggle: value.keys?.toggle ?? defaultShowKeys.toggle,
      quit: value.keys?.quit ?? defaultShowKeys.quit,
    },
    colors: {
      border: value.colors?.border ?? "#808080",
      activeBorder: value.colors?.activeBorder ?? "#00AFAF",
    },
  };
}
export async function loadShowSettings(path: string): Promise<ShowSettings> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ShowArgumentError("show設定ファイルを読み取れません。");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const show = (value as { show?: unknown }).show;
    return showSettingsSchema.parse(show === undefined ? {} : show);
  } catch { throw new ShowArgumentError("show設定が不正です。keysのキー形式・重複、colorsの#RRGGBBを確認してください。"); }
}
