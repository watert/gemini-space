/**
 * gemini-space 本机工具调用器：通过 stdio 起一个服务进程，直接调用任意 MCP 工具。
 * 用途：不经过 Gemini 桌面 app 也能验证工具行为（读写 / 命令 / 后台任务 / user_rules）。
 *
 *   gemini-space-call tools
 *   gemini-space-call call run_command '{"CommandLine":"ls -la ~/docs"}'
 *   gemini-space-call run_command '{"CommandLine":"ls"}'      # call 可省略
 *   gemini-space-call user_rules '{"Path":"/Users/waterwu/docs"}'
 *
 * 选项：--json 输出原始 MCP 结果；--timeout <ms> 单次调用超时；--workspace <dir> 覆盖工作目录；
 *      --detach 调用后强杀服务进程，让后台任务存活（用于验证 manage_task 跨进程）；
 *      --verbose 把服务端日志（stderr）透到终端，默认静默。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const USAGE = `用法:
  gemini-space-call tools [--json]
  gemini-space-call [call] <tool> [<json-args>|'-'] [--json] [--detach] [--verbose] [--timeout <ms>] [--workspace <dir>]

示例:
  gemini-space-call tools
  gemini-space-call read_file '{"Path":"/etc/hosts","StartLine":1,"EndLine":5}'
  gemini-space-call run_command '{"CommandLine":"ls ~/docs | head"}'
  gemini-space-call user_rules '{"Path":"/Users/waterwu/docs","Query":"naming"}'
  echo '{"CommandLine":"echo hi"}' | gemini-space-call run_command -
`;

interface Parsed {
  mode: "tools" | "call" | "help";
  tool?: string;
  rawArgs: string;
  json: boolean;
  detach: boolean;
  verbose: boolean;
  timeoutMs: number;
  workspace?: string;
}

function parse(argv: string[]): Parsed {
  const flags = new Set<string>();
  let workspace: string | undefined;
  let timeoutMs = 120_000;
  const positional: string[] = [];
  let detach = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") flags.add("json");
    else if (arg === "--detach") detach = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--help" || arg === "-h") flags.add("help");
    else if (arg === "--workspace") workspace = argv[++i];
    else if (arg === "--timeout") timeoutMs = Number(argv[++i] ?? NaN);
    else positional.push(arg);
  }
  const json = flags.has("json");
  if (flags.has("help") || positional.length === 0) {
    return { mode: "help", rawArgs: "", json, detach, verbose, timeoutMs };
  }
  if (positional[0] === "tools") {
    return { mode: "tools", rawArgs: "", json, detach, verbose, timeoutMs, workspace };
  }
  const [first, second, third] = positional;
  if (first === "call") {
    return {
      mode: "call",
      tool: second,
      rawArgs: third ?? "{}",
      json,
      detach,
      verbose,
      timeoutMs,
      workspace,
    };
  }
  return { mode: "call", tool: first, rawArgs: second ?? "{}", json, detach, verbose, timeoutMs, workspace };
}

async function readArgs(rawArgs: string): Promise<Record<string, unknown>> {
  const text = rawArgs === "-" ? await BunStdin() : rawArgs;
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("参数必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

async function BunStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

// 把 MCP content 块渲染成终端可读文本；图片只报类型与体积，不刷屏。
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((block): string => {
      if (!block || typeof block !== "object") return String(block);
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return `[image ${String(b.mimeType)} ${String(b.data).length}b base64]`;
      if (b.type === "audio") return `[audio ${String(b.mimeType)} ${String(b.data).length}b base64]`;
      if (b.type === "resource") {
        const res = (b.resource ?? {}) as Record<string, unknown>;
        return `[resource ${String(res.uri)} ${String(res.mimeType)}]`;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2));
  if (opts.mode === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.mode === "call" && !opts.tool) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const serverPath = fileURLToPath(new URL("../bin/gemini-space-stdio.js", import.meta.url));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (opts.workspace) env.DEVSPACE_AGY_WORKSPACE = opts.workspace;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
    // 服务端日志默认不往终端灌：它已经落在 ~/Library/Logs/gemini-space-stdio.log。
    stderr: opts.verbose ? "inherit" : "ignore",
  });
  const client = new Client({ name: "gemini-space-call", version: "1.0.0" });
  await client.connect(transport);

  // --detach 时不能让 client.close() 走优雅关停，否则 server 会把后台任务一起杀掉。
  let skipClose = false;
  try {
    if (opts.mode === "tools") {
      const { tools } = await client.listTools(undefined, { timeout: opts.timeoutMs });
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      } else {
        for (const tool of tools) {
          // 描述里混着 \n / \r / U+2028 等分隔符，统一压成一行再截断。
          const flat = (tool.description ?? "").replace(/\s+/g, " ").trim();
          const summary = flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
          process.stdout.write(`${tool.name.padEnd(13)} ${summary}\n`);
        }
      }
      return;
    }

    const args = await readArgs(opts.rawArgs);
    const result = await client.callTool(
      { name: opts.tool!, arguments: args },
      undefined,
      { timeout: opts.timeoutMs },
    );
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderContent(result.content)}\n`);
    }
    if (result.isError) process.exitCode = 1;

    if (opts.detach) {
      const pid = transport.pid;
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ }
      }
      skipClose = true;
    }
  } finally {
    if (!skipClose) await client.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`gemini-space-call: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
