import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgyBridge, buildServerInstructions, type BridgeToolCallResult } from "./agy-bridge.js";
import { loadConfig } from "./config.js";
import { discoverLocalSkills, formatSkillsForInstructions } from "./skills.js";
import { loadDevspaceFiles } from "./user-config.js";
import { DEVSPACE_VERSION } from "./version.js";

// stdio 单进程固定会话：所有工具调用共用同一份桥接会话状态。
const STDIO_MCP_SESSION_ID = "stdio-single-process";
const PROBE_TIMEOUT_MS = 1_500;
const MAX_LOG_LINE_BYTES = 4_096;

// stdout 是 JSON-RPC 通道；任何 console.log（包括 logger.ts 的 info/debug 日志）都必须改道 stderr。
const logFilePath = process.env.GEMINI_SPACE_LOG_FILE?.trim();
let logFd: number | undefined;
if (logFilePath) {
  try {
    logFd = openSync(logFilePath, "a", 0o600);
  } catch (error) {
    process.stderr.write(`stdio log file unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function truncateLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  return bytes.length <= MAX_LOG_LINE_BYTES - 1 ? line : bytes.subarray(0, MAX_LOG_LINE_BYTES - 1).toString("utf8");
}

// 旁路文件日志：优先 stderr，文件失败不影响协议或工具调用。
function writeStdioLog(level: string, message: string, fields: Record<string, unknown> = {}): void {
  const line = truncateLine(JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    level,
    message,
    ...fields,
  }));
  console.error(line);
  if (logFd === undefined) return;
  try {
    writeSync(logFd, `${line}\n`);
  } catch {
    // 旁路日志写入失败时保持静默，避免污染 stdout。
  }
}

// 第三方模块的 console.log 也进入 stderr + 旁路文件；logEvent 的 JSON 行保留结构化字段。
console.log = ((...args: unknown[]): void => {
  const message = args
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join(" ");
  if (args.length === 1 && typeof args[0] === "string" && args[0].startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(args[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entry = parsed as Record<string, unknown>;
        if (typeof entry.level === "string" && typeof entry.event === "string") {
          const fields: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(entry)) {
            if (!["ts", "pid", "level", "event", "message"].includes(key)) fields[key] = value;
          }
          writeStdioLog(entry.level, entry.event, fields);
          return;
        }
      }
    } catch {
      // 非 JSON 文本按普通消息记录。
    }
  }
  writeStdioLog("info", "console.log", { message });
}) as typeof console.log;

function probeBinary(name: string): string | null {
  try {
    const output = execFileSync("which", [name], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function loadStdioConfig(): { config: ReturnType<typeof loadConfig>; localOwnerToken: boolean } {
  const env = process.env;
  let localOwnerToken = false;
  if (!env.DEVSPACE_OAUTH_OWNER_TOKEN?.trim() && !loadDevspaceFiles(env).auth.ownerToken?.trim()) {
    // stdio 没有 HTTP/OAuth 流程；仅在完全缺失时注入一次性本地占位值满足 loadConfig 校验，绝不打印其内容。
    env.DEVSPACE_OAUTH_OWNER_TOKEN = `stdio-local-${randomBytes(24).toString("hex")}`;
    localOwnerToken = true;
  }
  return { config: loadConfig(env), localOwnerToken };
}

async function main(): Promise<void> {
  // GUI 拉起的 MCP 客户端 env 往往只有 /usr/bin:/bin；补齐常见工具目录，子进程（run_command）会继承。
  const extraPaths = [`${homedir()}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${homedir()}/.local/bin`];
  const currentPath = (process.env.PATH ?? "").split(":").filter(Boolean);
  const missingPaths = extraPaths.filter((p) => existsSync(p) && !currentPath.includes(p));
  if (missingPaths.length > 0) process.env.PATH = [...currentPath, ...missingPaths].join(":");

  const { config, localOwnerToken } = loadStdioConfig();
  const pathProbes: Record<string, string | null> = {};
  for (const name of ["bun", "node", "python3", "rg", "git", "obsidian"]) {
    pathProbes[name] = probeBinary(name);
  }

  writeStdioLog("info", "stdio_startup", {
    cwd: process.cwd(),
    workspace: config.agy.workspace,
    pathProbes,
    pathAdded: missingPaths,
  });
  // 只记录非敏感 config 关键项，绝不输出 oauth token 等秘密。
  writeStdioLog("info", "stdio_config", {
    configDir: config.configDir,
    stateDir: config.stateDir,
    agyBin: config.agy.bin,
    agyHome: config.agy.agyHome,
    workspace: config.agy.workspace,
    modelId: config.agy.modelId,
    wireProtocol: config.agy.wireProtocol,
    holdMs: config.agy.holdMs,
    exposedTools: config.agy.exposedTools,
    skillsEnabled: config.skills.enabled,
    codeModeEnabled: config.codeMode.enabled,
    loggingLevel: config.logging.level,
    localOwnerToken,
  });
  if (!pathProbes.python3) {
    writeStdioLog("warn", "python3_missing", { message: "PTY will degrade" });
  }

  const bridge = new AgyBridge(config.agy, config.logging);
  await bridge.start();

  const discoveredSkills = discoverLocalSkills(config.skills);
  // stdio 只暴露桥接工具，因此 instructions 不宣称 code mode 的 execute 工具。
  const instructions = buildServerInstructions(config.agy.holdMs, {
    skillsSection: formatSkillsForInstructions(discoveredSkills),
    codeModeEnabled: config.codeMode.enabled,
  });

  const server = new Server(
    { name: "gemini-space", version: DEVSPACE_VERSION },
    { capabilities: { tools: {} }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await bridge.listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (callReq) => {
    const { name, arguments: rawToolArgs } = callReq.params;
    try {
      return await bridge.callTool(
        STDIO_MCP_SESSION_ID,
        name,
        rawToolArgs as Record<string, unknown> | undefined,
      ) as BridgeToolCallResult;
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: error instanceof Error ? error.message : String(error),
        }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  writeStdioLog("info", "stdio_ready", { sessionId: STDIO_MCP_SESSION_ID });

  let closing: Promise<void> | undefined;
  const shutdown = (signal: string): void => {
    closing ??= (async () => {
      writeStdioLog("info", "stdio_shutdown", { signal });
      await server.close();
      await bridge.close();
      if (logFd !== undefined) closeSync(logFd);
    })();
    void closing.then(() => process.exit(0)).catch((error: unknown) => {
      process.stderr.write(`stdio shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

await main().catch((error: unknown) => {
  writeStdioLog("error", "stdio_startup_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
