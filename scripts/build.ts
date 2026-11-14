import { mkdir, readdir, rm } from "node:fs/promises";
const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });
for (const name of await readdir(output)) await rm(new URL(name, output), { recursive: true, force: true });
const child = Bun.spawn([process.execPath, "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await child.exited);
