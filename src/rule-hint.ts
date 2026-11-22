/**
 * 规则根软提示：工具调用成功后，按路径上溯到最近的规则根，提示模型调用 user_rules。
 * 只做提示，不改变任何工具结果或边界判定。
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findRuleRoot } from "./user-rules.js";

export class RuleHintTracker {
  private readonly home: string;
  /** realpath(目录) -> realpath(规则根)，null 表示该目录上溯无规则根。 */
  private readonly dirRoots = new Map<string, string | null>();
  /** 保留首次命中的非 realpath 根路径，避免把 ~/docs 显示成 iCloud 目标长路径。 */
  private readonly rootDisplays = new Map<string, string>();
  private readonly hintedRoots = new Set<string>();

  constructor(homeDir: string) {
    this.home = resolve(homeDir);
  }

  probe(displayPath: string | undefined): string | null {
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

    if (!rootReal || this.hintedRoots.has(rootReal)) return null;
    this.hintedRoots.add(rootReal);
    const displayRoot = this.rootDisplays.get(rootReal) ?? displayPathFor(rootReal, this.home);
    return `\n[rules] ${displayRoot} has project rules — call user_rules(Path: "${displayRoot}") for AGENTS.md and skills.`;
  }
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
