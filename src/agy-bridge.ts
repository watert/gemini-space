import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  executeManageTask,
  executeRunCommand,
  killAllSessionTasks,
  readTaskSidecars,
  type ManagedTaskRecord,
  type SessionNoticeItem,
  type SessionTaskContext,
} from "./agy-command-runner.js";
import {
  executeEditFile,
  executeReadFile,
  executeWriteFile,
  type InlineMediaItem,
} from "./agy-file-tools.js";
import {
  AGY_BUILTIN_DECLARATIONS,
  AgyToolExecutionError,
  AgyToolValidationError,
  USER_RULES_DECLARATION,
  USER_RULES_TOOL_NAME,
  formatAgyTimestamp,
  validateAgyToolArgs,
  type AgyFunctionDeclaration,
} from "./agy-tool-schemas.js";
import { collectUserRules, formatUserRulesText, type UserRulesOptions } from "./user-rules.js";
import { RuleHintTracker } from "./rule-hint.js";
import type { AgyBridgeConfig } from "./config.js";
import { commandPreview, logEvent, type LoggingConfig } from "./logger.js";
import { cleanGeminiToolSchema } from "./schema-clean.js";

// 资源回收上限：防止 daemon/后台任务持续产出通知与记录，导致 session 永不回收、内存无界增长。
const MAX_NOTICES_PER_SESSION = 200;
const MAX_COMPLETED_TASKS = 200;
const MAX_ACTIVE_SESSIONS = 64;

export type { AgyFunctionDeclaration };

export interface ExposedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface BridgeToolCallResult {
  [key: string]: unknown;
  content: McpContentBlock[];
  isError?: boolean;
}

// stdio 客户端可能每轮对话重启服务子进程；固定派生 sessionUuid 让 TaskId 与
// 任务目录跨进程可复现，否则内存态一丢就查不到上一轮的任务。
const STDIO_MCP_SESSION_ID = "stdio-single-process";

function deriveSessionUuid(mcpSessionId: string): string {
  if (mcpSessionId !== STDIO_MCP_SESSION_ID) return randomUUID();
  const hex = createHash("sha1").update(`gemini-space:${mcpSessionId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

class McpSessionEntry implements SessionTaskContext {
  readonly sessionUuid: string;
  lastUsedAt = Date.now();
  private stepCounter = -2;
  /** 最近一次已发出调用量提醒的计数，避免同一档位重复刷屏。 */
  private warnedCallCount = 0;
  readonly tasksByStep = new Map<number, ManagedTaskRecord>();
  readonly notices: SessionNoticeItem[] = [];
  readonly ruleHints: RuleHintTracker;

  constructor(
    readonly mcpSessionId: string,
    readonly stateRoot: string,
    readonly workspace: string,
  ) {
    this.sessionUuid = deriveSessionUuid(mcpSessionId);
    this.ruleHints = new RuleHintTracker(homedir(), {
      statePath: join(stateRoot, "brain", this.sessionUuid, ".system_generated", "rule-hints.json"),
    });
    // 从磁盘恢复 stepCounter：stdio 进程每轮重启，若从 -2 重新开始会覆盖上一轮同名任务。
    try {
      const existing = readTaskSidecars(this);
      if (existing.length > 0) this.stepCounter = existing[existing.length - 1]!.stepIndex;
    } catch {
      // 恢复失败时退回默认计数，最多覆盖同 stepIndex 的历史 sidecar。
    }
  }

  nextStepIndex(): number {
    this.stepCounter += 4;
    return this.stepCounter;
  }

  /** 当前 step 序号 (-2 起、每次调用 +4)，仅供 TaskId 步号校验。 */
  currentStepIndex(): number {
    return this.stepCounter;
  }

  /** 本会话累计工具调用次数：由 stepCounter 反算，跨进程可从 sidecar 步号恢复。 */
  currentToolCallCount(): number {
    return Math.max(0, Math.round((this.stepCounter + 2) / 4));
  }

  /** 是否该发一次调用量提醒：跨过一个阈值后记账，同档位不重发。 */
  shouldWarnToolCalls(warnAt: number): boolean {
    if (warnAt <= 0) return false;
    const calls = this.currentToolCallCount();
    if (calls < this.warnedCallCount + warnAt) return false;
    this.warnedCallCount = calls;
    return true;
  }

  hasRunningTasks(): boolean {
    for (const t of this.tasksByStep.values()) {
      if (t.status === "RUNNING") return true;
    }
    return false;
  }

  pushNotice(notice: SessionNoticeItem): void {
    this.notices.push(notice);
    while (this.notices.length > MAX_NOTICES_PER_SESSION) {
      // 优先丢弃已送达的最旧通知；全部未送达时才丢弃最旧的一条。
      const oldestDelivered = this.notices.findIndex((n) => n.delivered);
      this.notices.splice(oldestDelivered >= 0 ? oldestDelivered : 0, 1);
    }
  }

  pruneCompletedTasks(): void {
    const completed = [...this.tasksByStep.values()]
      .filter((t) => t.status !== "RUNNING")
      .sort((a, b) => a.stepIndex - b.stepIndex);
    const excess = completed.length - MAX_COMPLETED_TASKS;
    for (let i = 0; i < excess; i += 1) {
      this.tasksByStep.delete(completed[i]!.stepIndex);
    }
  }

  markNoticeDelivered(sender: string): void {
    for (const n of this.notices) {
      if (n.sender === sender) {
        n.delivered = true;
      }
    }
  }

  takeFreshNotices(excludeTaskId?: string): string {
    const fresh = this.notices.filter((n) => !n.delivered);
    for (const n of fresh) {
      n.delivered = true;
    }
    const extra = excludeTaskId ? fresh.filter((n) => n.sender !== excludeTaskId) : fresh;
    if (extra.length === 0) return "";
    return "\n\n" + extra.map((n) => `[Notice ${n.ts}] ${n.text}`).join("\n\n");
  }
}

export function buildServerInstructions(
  holdMs: number,
  options: { skillsSection?: string; codeModeEnabled?: boolean } = {},
): string {
  const holdSeconds = Math.round(holdMs / 1000);
  const parts = [
    "agy 风格的本地操作。已知工作区路径时,优先用客户端自带的读写执行工具,失败或无权限再改用这里的工具;如果工作区路径带 iCloud 且以 watert/user-docs 结尾,它就是 ~/docs,先调 user_rules 看规则与 skills。",
    "These tools run directly on the owner's Mac with full local filesystem and zsh permissions, matching Antigravity (agy) tool semantics.",
    "Always pass absolute file paths to read_file, write_file, and edit_file; no workspace-open step is needed.",
    "Before making changes in an unfamiliar directory, call `user_rules` with its absolute Path: it returns the nearest AGENTS.md / CLAUDE.md rule root and local skills that apply there. Read the listed files with read_file before acting.",
    `Non-daemon run_command calls automatically wait on the server for up to ${holdSeconds} seconds so most commands finish in one call.`,
    `If run_command exceeds ${holdSeconds} seconds and returns a background task id, call manage_task with Action "status" and that TaskId: the server holds each status check up to ${holdSeconds} seconds until the task finishes. Repeat until completion when your task depends on the output.`,
    "Completion notices for background tasks in your session are also appended to subsequent tool results.",
  ];

  if (options.codeModeEnabled) {
    parts.push(
      "When you need to chain or fan out many local file/command operations in a single turn, prefer `execute` (Code Mode) to run an async JS snippet calling `tools.read_file` / `tools.edit_file` / `tools.run_command` and return the aggregated result.",
    );
  }

  if (options.skillsSection) {
    parts.push(options.skillsSection);
  }

  return parts.join("\n\n");
}

export class AgyBridge {
  private readonly mcpSessions = new Map<string, McpSessionEntry>();
  private readonly sessionsByUuid = new Map<string, McpSessionEntry>();
  private readonly fileWriteLocks = new Map<string, Promise<void>>();
  private gcTimer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(
    private readonly config: AgyBridgeConfig,
    private readonly logging: LoggingConfig,
  ) {}

  async start(): Promise<void> {
    mkdirSync(this.config.agyHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.config.workspace, { recursive: true });

    this.gcTimer = setInterval(() => this.pruneIdleSessions(), 5 * 60_000);
    this.gcTimer.unref();

    logEvent(this.logging, "info", "agy_bridge_ready", {
      mode: "native-deterministic",
      workspace: this.config.workspace,
      exposedTools: this.config.exposedTools.join(","),
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
    for (const entry of this.mcpSessions.values()) {
      killAllSessionTasks(entry.tasksByStep);
    }
    this.mcpSessions.clear();
    this.sessionsByUuid.clear();
  }

  async listTools(): Promise<ExposedMcpTool[]> {
    const allowed = new Set(this.config.exposedTools);
    const agyTools = AGY_BUILTIN_DECLARATIONS
      .filter((d) => allowed.has(d.name) && d.name !== "ask_question")
      .map((d) => ({
        name: d.name,
        description: d.description ?? "",
        inputSchema: cleanGeminiToolSchema(d.parameters ?? d.parametersJsonSchema ?? { type: "object" }),
      }));
    // user_rules 是自建扩展，不受 exposedTools 控制（它不会执行本地命令，只是读规则）。
    return [
      ...agyTools,
      {
        name: USER_RULES_DECLARATION.name,
        description: USER_RULES_DECLARATION.description ?? "",
        inputSchema: cleanGeminiToolSchema(USER_RULES_DECLARATION.parameters ?? { type: "object" }),
      },
    ];
  }

  isToolExposed(name: string): boolean {
    if (name === USER_RULES_TOOL_NAME) return true;
    return name !== "ask_question" && this.config.exposedTools.includes(name);
  }

  dropMcpSession(mcpSessionId: string | undefined): void {
    const key = mcpSessionId?.trim();
    if (!key) return;
    const entry = this.mcpSessions.get(key);
    if (!entry || entry.hasRunningTasks()) return;
    this.sessionsByUuid.delete(entry.sessionUuid);
    this.mcpSessions.delete(key);
  }

  activeSessionCount(): number {
    return this.mcpSessions.size;
  }

  async callTool(
    mcpSessionId: string | undefined,
    name: string,
    rawArgs: Record<string, unknown> | undefined,
  ): Promise<BridgeToolCallResult> {
    if (this.closing) {
      return {
        content: [{ type: "text", text: "AGY bridge is shutting down" }],
        isError: true,
      };
    }

    if (!this.isToolExposed(name)) {
      return {
        content: [{ type: "text", text: `Unknown or disabled tool: ${name}` }],
        isError: true,
      };
    }

    const args = rawArgs ?? {};
    const targetEntry = this.resolveTargetSession(mcpSessionId, name, args);
    targetEntry.lastUsedAt = Date.now();
    // 调用量只做软提醒：服务端真正的资源边界是并发会话数 / 任务数 / 单次调用超时。
    // stdio 客户端共用一个固定会话 UUID，历史账本会跨对话累积，硬拦只会误伤长任务。
    if (targetEntry.shouldWarnToolCalls(this.config.warnToolCallsPerSession)) {
      const calls = targetEntry.currentToolCallCount();
      targetEntry.pushNotice({
        sender: "agy-bridge",
        ts: formatAgyTimestamp(),
        delivered: false,
        text:
          `本会话此前已累计 ${calls} 次工具调用。若是长任务可继续; 若上下文已经很长,` +
          `新开一个对话会更稳 (计数跨轮恢复, 不代表任何资源上限)。`,
      });
      logEvent(this.logging, "warn", "session_tool_call_warning", {
        calls,
        warnAt: this.config.warnToolCallsPerSession,
        agySessionId: targetEntry.sessionUuid.slice(0, 12),
      });
    }
    const callStart = Date.now();

    const execute = async (): Promise<BridgeToolCallResult> => {
      let outText = "";
      let isError = false;
      let images: InlineMediaItem[] = [];
      let suppressNoticeForTask: string | undefined;

      try {
        validateAgyToolArgs(name, args);

        if (name === "read_file") {
          targetEntry.nextStepIndex();
          const res = executeReadFile(args);
          outText = res.text;
          images = res.images;
        } else if (name === "write_file") {
          targetEntry.nextStepIndex();
          const res = executeWriteFile(args);
          outText = res.text;
        } else if (name === "edit_file") {
          targetEntry.nextStepIndex();
          const res = executeEditFile(args);
          outText = res.text;
        } else if (name === "run_command") {
          const res = await executeRunCommand(targetEntry, args, this.config.holdMs);
          outText = res.text;
          isError = Boolean(res.isError);
        } else if (name === "manage_task") {
          targetEntry.nextStepIndex();
          const res = await executeManageTask(targetEntry, args, this.config.holdMs);
          outText = res.text;
          suppressNoticeForTask = res.suppressNoticeTaskId;
        } else if (name === USER_RULES_TOOL_NAME) {
          targetEntry.nextStepIndex();
          const res = await collectUserRules(args as UserRulesOptions, { homeDir: homedir() });
          const detail = args.Detail === "full" ? "full" : "list";
          outText = formatUserRulesText(res, detail);
        } else {
          throw new AgyToolExecutionError(`unsupported tool: ${name}`);
        }
      } catch (err) {
        isError = true;
        if (err instanceof AgyToolValidationError || err instanceof AgyToolExecutionError) {
          outText = err.message;
        } else {
          outText = `Encountered error in tool execution: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      targetEntry.pruneCompletedTasks();
      let hint: string | null = null;
      if (!isError) {
        if (name === USER_RULES_TOOL_NAME) {
          const pathArg = typeof args.Path === "string" && args.Path.length > 0 ? args.Path : this.config.workspace;
          targetEntry.ruleHints.markHinted(pathArg);
        } else {
          hint = this.probeRuleHint(targetEntry, name, args);
        }
      }
      const extraNotices = targetEntry.takeFreshNotices(suppressNoticeForTask);
      const content: McpContentBlock[] = [
        { type: "text", text: outText + (hint ?? "") + extraNotices },
        ...images.map((media): McpContentBlock => this.mediaToContentBlock(media, args)),
      ];

      logEvent(this.logging, "info", "tool_call", {
        tool: name,
        mcpSessionId: targetEntry.mcpSessionId.slice(0, 12),
        agySessionId: targetEntry.sessionUuid.slice(0, 12),
        durationMs: Date.now() - callStart,
        isError,
        ...(name === "run_command" && this.logging.shellCommands && typeof args.CommandLine === "string"
          ? { command: commandPreview(args.CommandLine) }
          : {}),
      });

      return isError ? { content, isError: true } : { content };
    };

    if ((name === "write_file" || name === "edit_file") && typeof args.Path === "string" && args.Path.length > 0) {
      return this.withFileWriteLock(args.Path, execute);
    }

    return execute();
  }

  private probeRuleHint(entry: McpSessionEntry, name: string, args: Record<string, unknown>): string | null {
    if (name === "read_file" || name === "write_file" || name === "edit_file") {
      for (const key of ["Path", "FilePath", "Target"] as const) {
        const value = args[key];
        if (typeof value === "string" && value.length > 0) return entry.ruleHints.probe(value);
      }
      return null;
    }
    if (name === "run_command") {
      const cmd = typeof args.CommandLine === "string" ? args.CommandLine : undefined;
      return entry.ruleHints.probeCommand(cmd, this.config.workspace);
    }
    return null;
  }

  private mediaToContentBlock(media: InlineMediaItem, args: Record<string, unknown>): McpContentBlock {
    if (media.mimeType.startsWith("image/")) {
      return { type: "image", data: media.data, mimeType: media.mimeType };
    }
    if (media.mimeType.startsWith("audio/")) {
      return { type: "audio", data: media.data, mimeType: media.mimeType };
    }
    const filePath = typeof args.Path === "string" ? args.Path : "/attachment";
    return {
      type: "resource",
      resource: {
        uri: `file://${filePath}`,
        mimeType: media.mimeType,
        blob: media.data,
      },
    };
  }

  private resolveTargetSession(
    mcpSessionId: string | undefined,
    toolName: string,
    args: Record<string, unknown>,
  ): McpSessionEntry {
    const trimmedMcpId = mcpSessionId?.trim();
    // Stateless fallback: if caller omitted Mcp-Session-Id, route manage_task by TaskId prefix
    if (
      !trimmedMcpId
      && toolName === "manage_task"
      && typeof args.TaskId === "string"
      && args.TaskId.includes("/")
    ) {
      const prefix = args.TaskId.split("/")[0]!;
      const owner = this.sessionsByUuid.get(prefix);
      if (owner) return owner;
    }

    const key = trimmedMcpId || "stateless";
    let entry = this.mcpSessions.get(key);
    if (!entry) {
      if (this.mcpSessions.size >= MAX_ACTIVE_SESSIONS) {
        const victim = [...this.mcpSessions.values()]
          .filter((candidate) => !candidate.hasRunningTasks())
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (victim) {
          this.sessionsByUuid.delete(victim.sessionUuid);
          this.mcpSessions.delete(victim.mcpSessionId);
        } else {
          logEvent(this.logging, "warn", "active_session_limit_exceeded", {
            activeSessions: this.mcpSessions.size,
            limit: MAX_ACTIVE_SESSIONS,
          });
        }
      }
      entry = new McpSessionEntry(key, this.config.agyHome, this.config.workspace);
      this.mcpSessions.set(key, entry);
      this.sessionsByUuid.set(entry.sessionUuid, entry);
    }
    return entry;
  }

  private async withFileWriteLock<T>(rawPath: string, fn: () => Promise<T>): Promise<T> {
    const normalized = resolve(this.config.workspace, rawPath);
    const prev = this.fileWriteLocks.get(normalized) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => gate);
    this.fileWriteLocks.set(normalized, chained);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.fileWriteLocks.get(normalized) === chained) {
        this.fileWriteLocks.delete(normalized);
      }
    }
  }

  private pruneIdleSessions(): void {
    const now = Date.now();
    for (const [key, entry] of this.mcpSessions) {
      if (!entry.hasRunningTasks() && now - entry.lastUsedAt > this.config.sessionIdleTtlMs) {
        this.sessionsByUuid.delete(entry.sessionUuid);
        this.mcpSessions.delete(key);
      }
    }
  }
}
