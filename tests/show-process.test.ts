import { it } from "bun:test";
import { resolve } from "node:path";
import { verifyTerminalShow } from "./helpers/show-terminal.js";

it.each([[false, false], [false, true], [true, false], [true, true]])("疑似端末show: キー置換=%s 詳細から終了=%s", async (custom, detail) => {
  await verifyTerminalShow(process.execPath, [resolve("dist/index.js")], custom!, detail!);
}, 60_000);
