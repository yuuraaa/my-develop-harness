import { performance } from "node:perf_hooks";
import type { RunEvent, RunState } from "./schemas.js";
import { RunStore } from "./state.js";

const phases: Record<RunState["phase"], string> = {
  prepare: "準備", start: "Issue着手", plan: "計画作成",
  implementation: "実装", verification: "検証", review: "レビュー", fix: "修正", commit: "コミット",
  report: "報告作成・保存", push: "成果公開", comment: "Issue報告", review_state: "レビュー待ち更新",
};
const kinds: Record<string, string> = { prepare: "準備", test: "テスト", typecheck: "型チェック", build: "ビルド", other: "その他の検証" };
// ラベルは内部定義の日本語・ASCIIのみ。全角文字を2桁として端末の表示幅を揃える。
const labelWidth = (label: string) => Array.from(label).reduce((width, char) => width + (/[\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0);
const submission = "報告照合・review提出";
const columnWidth = 1 + Math.max(...[...Object.values(phases), submission, "レビュー 4回目", "修正 3/3"].map(labelWidth));
const formatPhase = (label: string, status: string) => `${label}${" ".repeat(Math.max(0, columnWidth - labelWidth(label)))}：${status}`;
export type ProgressOptions = { enabled?: boolean; isTTY?: boolean; now?: () => number };
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
};

/** 保存済みイベントを短い表示へ変換する。描画用制御文字は内部でのみ生成する。 */
export class RunProgress {
  private readonly started: number;
  private active: { key: string; label: string; started: number } | undefined;
  private closed = false;
  private readonly unsubscribe: () => void;
  private pendingLine = false;
  private readonly now: () => number;
  constructor(private readonly store: RunStore, issueReference: string, private readonly write: (text: string) => void,
    private readonly options: ProgressOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.started = this.now();
    if (options.enabled !== false) this.line(`${issueReference} を開始`);
    this.unsubscribe = store.observeEvents(event => this.observe(event));
  }
  private output(text: string) {
    try { this.write(text); } catch { /* 表示失敗でもワークフローは継続する。 */ }
  }
  private line(message: string, pending = false) {
    const seconds = Math.max(0, Math.floor((this.now() - this.started) / 1000));
    // 外部由来の改行や端末制御文字で表示構造を変更させない。
    const safe = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    this.output(`${this.pendingLine ? "\r\x1b[2K" : ""}[${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] ${safe}${pending && this.options.isTTY ? "" : "\n"}`);
    this.pendingLine = pending && this.options.isTTY === true;
  }
  private running() {
    if (this.active) this.line(formatPhase(this.active.label, "処理中..."), true);
  }
  private notice(message: string) {
    this.line(message);
    if (this.options.isTTY) this.running();
  }
  private end(status: string) {
    if (!this.active) return;
    this.line(formatPhase(this.active.label, status));
    this.active = undefined;
  }
  private begin(key: string, label: string) {
    if (this.active?.key === key) return;
    this.end("中断");
    this.active = { key, label, started: this.now() };
    this.running();
  }
  private observe(event: RunEvent) {
    if (this.closed || this.options.enabled === false) return;
    const { data, phase, type } = event;
    const attempt = typeof data.attempt === "number" ? data.attempt : 1;
    const key = `${phase}.${attempt}`;
    const label = phase === "review" ? `レビュー ${attempt}回目` : phase === "fix" ? `修正 ${attempt}/3` : phases[phase];
    if (type === "phase.running") {
      this.begin(key, label);
      if (typeof data.commandIndex === "number") {
        const status = { started: "開始", passed: "成功", failed: "失敗", skipped: "未実施" }[String(data.commandStatus)];
        if (status) this.notice(`検証 ${data.commandIndex + 1}/${data.commandTotal}：${kinds[String(data.commandKind)] ?? "検証"} (${data.commandId})：${status}`);
      }
    } else if (type === "phase.succeeded" && this.active?.key === key) {
      // レビューは後続の保存済み判定まで待ち、完了と合否を同じ行へ表示する。
      if (phase !== "review") this.end(`完了（${duration(this.now() - this.active.started)}）`);
    } else if (type === "operation.started" && data.operation === "report.submit") {
      this.begin("submission", submission);
    } else if (type === "operation.succeeded" && data.operation === "report.submit" && this.active?.key === "submission") {
      this.end(`完了（${duration(this.now() - this.active.started)}）`);
    } else if (type === "operation.retry") {
      this.notice(`再試行：${data.operation} ${data.retryCount}/2`);
    } else if (type === "workflow.stopped") {
      this.end("停止");
    } else if (type === "review.assessed") {
      if (this.active?.key === key) this.end(`完了（${data.decision === "passed" ? "合格" : "要修正"}、${duration(this.now() - this.active.started)}）`);
    } else if (type === "codex.event") {
      const action = { file_change: "ファイル変更を観測", mcp_tool_call: "資料参照中", web_search: "検索中" }[String(data.itemType)];
      if (action && (data.type === "item.started" || data.type === "item.completed")) {
        this.notice(formatPhase(label, data.type === "item.completed" && data.itemType === "mcp_tool_call" ? "資料参照終了" : action));
      }
    }
  }
  finish(status: RunState["status"], reason?: string) {
    if (this.closed) return;
    this.end(status === "completed" ? "終了（完了イベントなし）" : "停止");
    this.close();
    this.line(status === "completed" ? "review提出完了" : `停止状態: ${status}／理由: ${reason || "停止理由の記録なし"}`);
    this.output(`記録: ${this.store.runPath.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}\n`);
  }
  close() {
    if (this.closed) return;
    this.end("中断");
    this.closed = true;
    this.unsubscribe();
  }
}
