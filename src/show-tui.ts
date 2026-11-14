import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import type { ShowModel } from "./show-model.js";
import { resolveShowSettings } from "./show-settings.js";
import type { ShowSettings } from "./show-settings.js";

const segments = new Intl.Segmenter("ja", { granularity: "grapheme" });
export const displayWidth = (text: string) => Bun.stringWidth(text);
export function wrapShowText(text: string, width: number): string[] {
  const lines: string[] = [];
  const limit = Math.max(1, width);
  for (const source of text.replace(/\r\n/g, "\n").replace(/\r/g, "�").replace(/\t/g, "    ").split("\n")) {
    let row = "", used = 0;
    for (const { segment } of segments.segment(source)) {
      const size = displayWidth(segment);
      if (used + size > limit && row) { lines.push(row); row = ""; used = 0; }
      if (size > limit) { lines.push("�"); continue; }
      row += segment; used += size;
    }
    lines.push(row);
  }
  return lines;
}
const clip = (text: string, width: number) => wrapShowText(text, width)[0] ?? "";
const pad = (text: string, width: number) => { const s = clip(text, width); return s + " ".repeat(Math.max(0, width - displayWidth(s))); };
export type ShowTuiState = { selected: number; focus: "list" | "detail"; offset: number; listOffset: number };
export const initialShowState = (): ShowTuiState => ({ selected: 0, focus: "list", offset: 0, listOffset: 0 });
export function moveShow(state: ShowTuiState, action: string, count: number) {
  if (action === "quit") return true;
  if (action === "toggle") state.focus = state.focus === "list" ? "detail" : "list";
  if (action === "up" || action === "down") {
    if (state.focus === "detail") state.offset = Math.max(0, state.offset + (action === "up" ? -1 : 1));
    else {
      state.selected = (state.selected + (action === "up" ? count - 1 : 1)) % count;
      state.offset = 0;
    }
  }
  return false;
}
export function showAction(settings: ShowSettings, input: string, key: Key): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const named: Record<string, string> = { up: "up", down: "down", tab: "tab", escape: "escape", return: "enter", enter: "enter", space: "space" };
  if (key.shift && named[key.name ?? ""]) return undefined;
  const value = named[key.name ?? ""] ?? input;
  return Object.entries(resolveShowSettings(settings).keys).find(([, binding]) => binding === value)?.[0];
}
const color = (hex: string, s: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m${s}\x1b[39m`;
export function renderShow(model: ShowModel, state: ShowTuiState, columns: number, rows: number, settings: ShowSettings = {}): string {
  const width = Math.max(1, columns - 1), options = resolveShowSettings(settings);
  const phase = model.phases[state.selected]!;
  const labelKey = (key: string) => ({ up: "↑", down: "↓", tab: "Tab", escape: "Esc", enter: "Enter", space: "Space" } as Record<string, string>)[key] ?? key;
  const keys = `${labelKey(options.keys.up)}/${labelKey(options.keys.down)}:移動 ${labelKey(options.keys.toggle)}:切替 ${labelKey(options.keys.quit)}:終了`;
  if (width < 24 || rows < 12) return [clip("端末を広げてください", width), clip(`${phase.name} ${phase.result}`, width), clip(keys, width)].slice(0, rows).join("\r\n");
  const inner = width - 2;
  const listHeight = Math.min(Math.max(1, model.phases.length), Math.max(1, Math.floor((rows - 9) / 3)));
  const detailHeight = Math.max(1, rows - 9 - listHeight);
  state.listOffset = Math.max(0, Math.min(state.listOffset, state.selected));
  if (state.selected >= state.listOffset + listHeight) state.listOffset = state.selected - listHeight + 1;
  const details = wrapShowText(phase.detail, inner);
  state.offset = Math.min(state.offset, Math.max(0, details.length - detailHeight));
  const frame = (title: string, lines: string[], height: number, focus: "list" | "detail") => {
    const paint = (s: string) => color(focus === state.focus ? options.colors.activeBorder : options.colors.border, s);
    const label = clip(` ${title}${focus === state.focus ? " · 操作中" : ""} `, inner);
    return [paint("┌") + label + paint("─".repeat(inner - displayWidth(label)) + "┐"),
      ...Array.from({ length: height }, (_, i) => paint("│") + pad(lines[i] ?? "", inner) + paint("│")), paint("└" + "─".repeat(inner) + "┘")];
  };
  // 列幅は表示セル数で決め、色は枠線以外には一切使用しない。
  const nameWidth = Math.min(18, Math.max(8, Math.floor(inner * .22)));
  const resultWidth = Math.min(14, Math.max(6, Math.floor(inner * .17)));
  const durationWidth = Math.min(12, Math.max(5, Math.floor(inner * .14)));
  const list = model.phases.slice(state.listOffset, state.listOffset + listHeight).map((p, i) =>
    `${state.listOffset + i === state.selected ? "▶" : " "} ${pad(p.name, nameWidth)} ${pad(p.result, resultWidth)} ${pad(p.duration, durationWidth)} ${p.assessment}`);
  const output = [clip(model.heading[1] ?? "Issue: 不明", width), clip(model.heading[0] ?? "", width), clip(`${model.heading[2]} / ${model.heading[3]}`, width),
    ...frame(`一覧 ${state.selected + 1}/${model.phases.length} · 行${state.listOffset + 1}-${Math.min(model.phases.length, state.listOffset + listHeight)}/${model.phases.length}`, list, listHeight, "list"),
    ...frame(`行${state.offset + 1}-${Math.min(details.length, state.offset + detailHeight)}/${details.length} · ${phase.name} 詳細`, details.slice(state.offset), detailHeight, "detail"),
    ...wrapShowText(keys, width).slice(0, 2)];
  return output.slice(0, rows).map(line => line + "\x1b[K").join("\r\n");
}

export async function runShowTui(model: ShowModel, settings: ShowSettings = {}, input: ReadStream = process.stdin, output: WriteStream = process.stdout): Promise<void> {
  const state = initialShowState();
  const raw = input.isRaw;
  emitKeypressEvents(input);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      input.off("keypress", onKey); input.off("end", onEnd); input.off("error", onError);
      output.off("resize", draw); output.off("error", onError);
      process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); process.off("SIGHUP", onSignal);
      try { input.setRawMode(raw); } finally {
        // CLIが開始した入力監視を必ず止める。isPaused()が初期falseでも、
        // resume()したTTYを放置するとq後もイベントループが終了しない。
        input.pause();
        if (!output.destroyed && !output.writableEnded) output.write("\x1b[?25h\x1b[?1049l");
      }
    };
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      try { cleanup(); } catch (failure) { reject(failure); return; }
      if (error) reject(error); else resolve();
    };
    function draw() {
      try { output.write("\x1b[H" + renderShow(model, state, output.columns ?? 80, output.rows ?? 24, settings) + "\x1b[J"); }
      catch (error) { finish(error as Error); }
    }
    function onKey(value: string, key: Key) {
      // Ctrl+Cは端末を壊さないためのプロセス中断。領域切替キーではない。
      if (key.ctrl && key.name === "c") { finish(); return; }
      const action = showAction(settings, value, key);
      if (action && moveShow(state, action, model.phases.length)) finish(); else draw();
    }
    function onEnd() { finish(); }
    function onSignal() { finish(); }
    function onError(error: Error) { finish(error); }
    input.on("keypress", onKey); input.on("end", onEnd); input.on("error", onError);
    output.on("resize", draw); output.on("error", onError);
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); process.on("SIGHUP", onSignal);
    try { input.setRawMode(true); input.resume(); output.write("\x1b[?1049h\x1b[?25l"); draw(); }
    catch (error) { finish(error as Error); }
  });
}
