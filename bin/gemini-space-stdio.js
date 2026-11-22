#!/usr/bin/env node
import { runEntrypoint } from "./run-entrypoint.js";

// stdio 的 stdout 只承载 JSON-RPC；在进入入口模块前先把 console.log 改道 stderr。
console.log = (...args) => console.error(...args);

await runEntrypoint("../src/stdio-main.ts", "../dist/stdio-main.js");
