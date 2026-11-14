// 実端末用の確認入口。疑似端末の自動試験とは分けて実行する。
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { executeCli } from "../src/cli.js";
import { createShowFixture, showRunId } from "../tests/helpers/show-fixture.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("実端末確認は操作できるTTYから実行してください。未実施を成功扱いにしません。");
  process.exitCode = 1;
} else {
  const home = await mkdtemp(join(tmpdir(), "harness-show-manual-"));
  try {
    const fixture = await createShowFixture(home);
    for (let i = 3; i <= 64; i++) await fixture.save(`review-${i}.json`, { summary: `多数工程の表示確認 ${i}` });
    const cwd = await realpath(process.cwd());
    console.log(`実端末確認対象: ${cwd} / Bun ${Bun.version}`);
    for (const path of ["src/show-tui.ts", "src/show-model.ts", "src/show-settings.ts", "src/retrospective.ts", "src/cli.ts"]) {
      console.log(`${createHash("sha256").update(await readFile(path)).digest("hex")}  ${path}`);
    }
    const question = async (prompt: string) => {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { return await reader.question(prompt); } finally { reader.close(); process.stdin.pause(); }
    };
    for (const custom of [false, true]) {
      const up = custom ? "k" : "↑", down = custom ? "j" : "↓", toggle = custom ? "t" : "Tab", quit = custom ? "x" : "q";
      if (custom) await writeFile(join(fixture.root, "config.json"), JSON.stringify({ show: { keys: { up: "k", down: "j", toggle: "t", quit: "x" }, colors: { border: "#123456", activeBorder: "#abcdef" } } }));
      console.log(`確認モード: ${custom ? "設定キー" : "既定キー"} / 上=${up} 下=${down} 切替=${toggle} 終了=${quit}`);
      console.log("最初の工程・一覧操作から始まること、先頭の上移動で末尾、末尾の下移動で先頭が表示されることを確認してください。");
      console.log("implementation:1を選び、詳細の日本語長文の末尾までスクロールしてください。幅と高さを変え、一覧・選択・表示位置・枠線・操作案内を確認してください。");
      console.log("色は枠線2種類のみ。背景・本文・選択行は端末の色を維持することを確認してください。PageUp/PageDownでは動かないことも確認してください。");
      if (custom) console.log("↑/↓・Tab・qが無効で、k/j・t・xだけが該当操作に有効であることも確認してください。");
      for (const focus of ["一覧", "詳細"]) {
        await question(`${focus}を操作中に${quit}で全体を終了する確認を開始します。Enter: `);
        if (await executeCli(["show", showRunId], { root: fixture.root, env: {} }) !== 0) throw new Error("showの実行失敗");
        const answer = await question(`実端末の上記表示・操作と${focus}からの終了・端末復元をすべて確認できましたか（yesのみ合格）: `);
        if (answer.trim() !== "yes") throw new Error(`実端末確認未完了: ${custom ? "設定キー" : "既定キー"}/${focus}`);
        console.log(`実端末操作の確認者応答: ${custom ? "設定キー" : "既定キー"}/${focus} yes`);
      }
    }
    console.log("実端末確認完了（確認者の応答を含む。自動試験の結果とは別）。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "実端末確認失敗");
    process.exitCode = 1;
  } finally { await rm(home, { recursive: true, force: true }); }
}
