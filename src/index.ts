#!/usr/bin/env bun
import { executeCli } from "./cli.js";

process.exitCode = await executeCli();
