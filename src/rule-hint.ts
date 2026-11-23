/**
 * 规则根软提示：工具调用成功后，按路径上溯到最近的规则根，提示模型调用 user_rules。
 * 支持按 session 隔离、主动调用 user_rules 后抑制重复提示、命令行路径提取，以及带 TTL 的跨进程持久化。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findRuleRoot } from "./user-rules.js";

/** 默认跨进程去重窗口（30 分钟）：覆盖桌面端同对话子进程轮换，又不至于让次日新对话永久静默。 */
export const DEFAULT_RULE_HINT_TTL_MS = 30 * 60_000;

export interface RuleHintTrackerOptions {
  /** 可选持久化路径（如 <session>/.system_generated/rule-hints.json）。 */
  statePath?: string;
  /** 提示去重 TTL，默认 30 分钟；<= 0 表示不过期。 */
  ttlMs?: number;
  /** 时间源，测试可注入。 */
  now?: () => number;
}

interface PersistedRuleHints {
  roots?: Record<string, number>;
}

export class RuleHintTracker {
  private readonly home: string;
  private readonly statePath?: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** realpath(目录) -> realpath(规则根)，null 表示该目录上溯无规则根。 */
  private readonly dirRoots = new Map<string, string | null>();
  /** 保留首次命中的非 realpath 根路径，避免把 ~/docs 显示成 iCloud 目标长路径。 */
  private readonly rootDisplays = new Map<string, string>();
  /** realpath(规则根) -> 最近一次提示/加载时间戳。 */
  private readonly hintedRoots = new Map<string, number>();

  constructor(homeDir: string, options: RuleHintTrackerOptions = {}) {
    this.home = resolve(homeDir);
    this.statePath = options.statePath;
    this.ttlMs = options.ttlMs ?? DEFAULT_RULE_HINT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.loadState();
  }

  /** 首次触达某规则根时返回单行软提示，TTL 内再次触达返回 null。 */
  probe(displayPath: string | undefined): string | null {
    const resolved = this.resolveRuleRoot(displayPath);
    if (!resolved) return null;
    const ts = this.now();
    if (this.isFresh(resolved.rootReal, ts)) return null;
    this.hintedRoots.set(resolved.rootReal, ts);
    this.saveState(ts);
    return `\n[rules] ${resolved.displayRoot} has project rules — call user_rules(Path: "${resolved.displayRoot}") for AGENTS.md and skills.`;
  }

  /** 主动调用 user_rules 成功后记账，避免紧接着的读写再重复弹提示。 */
  markHinted(displayPath: string | undefined): void {
    const resolved = this.resolveRuleRoot(displayPath);
    if (!resolved) return;
    const ts = this.now();
    this.hintedRoots.set(resolved.rootReal, ts);
    this.saveState(ts);
  }

  /** 针对 run_command：优先提取命令行中存在的路径探测规则根，未命中时回退到 workspace。 */
  probeCommand(commandLine: string | undefined, fallbackWorkspace: string): string | null {
    const candidates = extractCommandPaths(commandLine);
    const hints: string[] = [];
    let matchedAnyRoot = false;

    for (const candidate of candidates) {
      const abs = resolve(expandHome(candidate, this.home));
      if (!existsSync(abs)) continue;
      if (!this.resolveRuleRoot(candidate)) continue;
      matchedAnyRoot = true;
      const hint = this.probe(candidate);
      if (hint) hints.push(hint);
    }

    if (matchedAnyRoot) return hints.length > 0 ? hints.join("") : null;
    return this.probe(fallbackWorkspace);
  }

  private resolveRuleRoot(displayPath: string | undefined): { rootReal: string; displayRoot: string } | null {
    if (!displayPath?.trim()) return null;
    const abs = resolve(expandHome(displayPath.trim(), this.home));

    let baseDir = abs;
    try {
      if (!statSync(abs).isDirectory()) baseDir = dirname(abs);
    } catch {
      // 路径不存在：退到父目录再上溯，父目录可能挂着规则。
      baseDir = dirname(abs);
    }

    const dirKey = safeRealpath(baseDir);
    let rootReal: string | null;
    if (this.dirRoots.has(dirKey)) {
      rootReal = this.dirRoots.get(dirKey) ?? null;
    } else {
      const root = findRuleRoot(baseDir, this.home);
      rootReal = root ? safeRealpath(root) : null;
      this.dirRoots.set(dirKey, rootReal);
      if (root && rootReal && !this.rootDisplays.has(rootReal)) {
        this.rootDisplays.set(rootReal, displayPathFor(root, this.home));
      }
    }

    if (!rootReal) return null;
    const displayRoot = this.rootDisplays.get(rootReal) ?? displayPathFor(rootReal, this.home);
    return { rootReal, displayRoot };
  }

  private isFresh(rootReal: string, ts: number): boolean {
    const prev = this.hintedRoots.get(rootReal);
    if (prev === undefined) return false;
    if (this.ttlMs <= 0) return true;
    return ts - prev < this.ttlMs;
  }

  private loadState(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedRuleHints;
      if (!raw || typeof raw.roots !== "object" || !raw.roots) return;
      const ts = this.now();
      for (const [rootReal, hintedAt] of Object.entries(raw.roots)) {
        if (typeof hintedAt !== "number" || !Number.isFinite(hintedAt)) continue;
        if (this.ttlMs > 0 && ts - hintedAt >= this.ttlMs) continue;
        this.hintedRoots.set(rootReal, hintedAt);
      }
    } catch {
      // 状态文件损坏或不可读时静默降级为纯内存去重。
    }
  }

  private saveState(ts: number): void {
    if (!this.statePath) return;
    try {
      const roots: Record<string, number> = {};
      for (const [rootReal, hintedAt] of this.hintedRoots) {
        if (this.ttlMs > 0 && ts - hintedAt >= this.ttlMs) continue;
        roots[rootReal] = hintedAt;
      }
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ roots }), "utf8");
      renameSync(tmp, this.statePath);
    } catch {
      // 落盘失败不影响主流程。
    }
  }
}

/** 从 shell 命令行里提取 ~/... 与 /... 候选路径，排除 URL（://）和纯根路径。 */
export function extractCommandPaths(commandLine: string | undefined): string[] {
  if (!commandLine?.trim()) return [];
  const seen = new Set<string>();
  const re = /(?:^|[\s"'=])((?:~\/|\/[A-Za-z0-9._-])[^\s"'`;&|<>()]*)/g;
  for (const match of commandLine.matchAll(re)) {
    const raw = match[1];
    if (!raw || raw.startsWith("//")) continue;
    const cleaned = raw.replace(/[,;:]+$/, "");
    if (cleaned.length > 1) seen.add(cleaned);
  }
  return [...seen];
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}

function displayPathFor(path: string, home: string): string {
  if (path === home) return "~";
  const rel = relative(home, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return "~/" + rel.split(sep).join("/");
  }
  return path;
}

function safeRealpath(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
