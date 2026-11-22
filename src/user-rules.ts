/**
 * 用户规则拉取工具（pull 模型）。
 * 只在调用时按需向上遍历规则链与 skills，不做启动期 push。
 * 目录枚举与 mtime 比对每次实时进行，仅 SKILL.md 的解析结果按 mtime/size 缓存。
 */

import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type UserRulesDetail = "list" | "full";
export type UserRulesScope = "auto" | "user" | "project" | "all";

export interface UserRulesOptions {
  Path?: string;
  Scope?: UserRulesScope;
  IncludeSkills?: boolean;
  Detail?: UserRulesDetail;
  Query?: string;
}
export interface UserRulesRuntime {
  homeDir: string;
  skillsPaths?: readonly string[];
  allowedRoots?: readonly string[];
}
export interface RuleFileEntry {
  layer: string;
  path: string;
  realPath: string;
  kind: "agents" | "claude" | "readme";
  bytes: number;
  isSymlink: boolean;
  linkTarget?: string;
  broken: boolean;
  content?: string;
}
export interface SkillEntry {
  layer: string;
  name: string;
  description: string;
  path: string;
  score: number;
}
export interface UserRulesResult {
  requestedPath: string;
  baseDir: string;
  rules: RuleFileEntry[];
  skills: SkillEntry[];
  warnings: string[];
  cached: boolean;
}

const MAX_DESCRIPTION_CHARS = 160;
const MAX_CONTENT_CHARS = 200_000;
interface SkillMeta {
  mtimeMs: number;
  size: number;
  name: string;
  description: string;
  raw?: string;
}
const skillCache = new Map<string, SkillMeta>();
const KNOWN_BROKEN_PATHS = [".agents/AGENTS.md", "docs/scripts", "docs/htmls", "docs/tmp",
  "docs/refs", "docs/posts-zhihu", "docs/post-topics"] as const;

export async function collectUserRules(
  options: UserRulesOptions,
  runtime: UserRulesRuntime,
): Promise<UserRulesResult> {
  // 上溯链与层名一律用未解析软链的原始路径：~/docs 这类别名比 iCloud 长路径好认得多。
  // realpath 只在去重与文件读取时用。
  const home = resolve(runtime.homeDir);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const requestedPath = options.Path ?? "";
  const detail = options.Detail ?? "list";
  let baseDir: string;
  let scope: UserRulesScope = options.Scope ?? "auto";
  if (!requestedPath.trim()) {
    baseDir = home;
    scope = "user";
  } else {
    const target = resolve(expandHome(requestedPath, home));
    let st: ReturnType<typeof statSync> | undefined;
    try { st = statSync(target); } catch { /* 不存在时仍按该路径上溯 */ }
    if (!st) {
      baseDir = target;
      warnings.push(`path does not exist: ${requestedPath}`);
    } else {
      baseDir = st.isFile() ? dirname(target) : target;
    }
  }
  if (runtime.allowedRoots?.length) {
    // 边界判断走 realpath，防止软链把路径绕出允许范围。
    const realBase = safeRealpath(baseDir);
    const inside = runtime.allowedRoots.some((root) =>
      isUnder(realBase, safeRealpath(resolve(expandHome(root, home)))),
    );
    if (!inside) throw new Error("path is outside allowed roots: " + baseDir);
  }

  const chain: string[] = [];
  for (let dir = baseDir; ; dir = dirname(dir)) {
    chain.push(dir);
    if (dir === dirname(dir)) break;
  }
  const rulePaths: Array<{ path: string; kind: RuleFileEntry["kind"] }> = [];
  const skillDirs: Array<{ path: string; layer: string }> = [];
  for (const dir of chain) {
    const layer = layerName(dir, home);
    rulePaths.push({ path: join(dir, "AGENTS.md"), kind: "agents" }, { path: join(dir, "CLAUDE.md"), kind: "claude" });
    if (basename(dir) === "my-codes") rulePaths.push({ path: join(dir, "README.md"), kind: "readme" });
    skillDirs.push({ path: join(dir, ".agents", "skills"), layer }, { path: join(dir, ".claude", "skills"), layer });
  }
  for (const extra of runtime.skillsPaths ?? []) {
    const dir = resolve(expandHome(extra, home));
    skillDirs.push({ path: dir, layer: layerName(dir, home) });
  }

  const rules: RuleFileEntry[] = [];
  const seenRules = new Set<string>();
  for (const candidate of rulePaths) {
    const layer = layerName(dirname(candidate.path), home);
    const entry = inspectRule(candidate.path, layer, candidate.kind, home, detail, warnings, warned);
    if (!entry || seenRules.has(entry.realPath)) continue;
    seenRules.add(entry.realPath);
    rules.push(entry);
  }
  const homeAgents = join(home, ".agents", "AGENTS.md");
  try {
    lstatSync(homeAgents);
    const entry = inspectRule(homeAgents, "~", "agents", home, detail, warnings, warned);
    if (entry && !seenRules.has(entry.realPath)) rules.push(entry);
  } catch {
    // 用户级兜底文件不存在。
  }
  for (const rel of KNOWN_BROKEN_PATHS) {
    const target = join(home, ...rel.split("/"));
    let lst: ReturnType<typeof lstatSync>;
    try { lst = lstatSync(target); } catch { continue; }
    if (!lst.isSymbolicLink()) continue;
    let linkTarget = "";
    try {
      linkTarget = readlinkSync(target);
      statSync(target);
    } catch {
      warnBroken(target, layerName(target, home), linkTarget, warnings, warned);
    }
  }

  const skills: SkillEntry[] = [];
  const seenSkills = new Set<string>();
  let cached = true;
  if (options.IncludeSkills !== false) {
    const query = options.Query?.trim().toLowerCase() ?? "";
    for (const dir of skillDirs) {
      let entries: string[];
      try { entries = readdirSync(dir.path).sort(); } catch { continue; }
      for (const name of entries) {
        const skillFile = join(dir.path, name, "SKILL.md");
        let st: ReturnType<typeof statSync>;
        try { st = statSync(skillFile); } catch { continue; }
        const real = safeRealpath(skillFile);
        if (seenSkills.has(real)) continue;
        seenSkills.add(real);
        const hit = skillCache.get(real);
        let meta: SkillMeta;
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          meta = hit;
        } else {
          cached = false;
          let raw: string;
          try { raw = readFileSync(skillFile, "utf8"); } catch { continue; }
          const parsed = parseSkillMarkdown(raw, name);
          meta = { mtimeMs: st.mtimeMs, size: st.size, ...parsed, raw };
          skillCache.set(real, meta);
        }
        const description = detail === "list" ? truncate(meta.description) : meta.description;
        const matched = query && (meta.name.toLowerCase().includes(query) || meta.description.toLowerCase().includes(query));
        skills.push({ layer: dir.layer, name: meta.name, description, path: skillFile, score: matched ? 100 : 0 });
      }
    }
    if (query) skills.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  const inScope = (layer: string): boolean =>
    scope === "user" ? layer === "~" : scope === "project" ? layer !== "~" : true;
  return {
    requestedPath,
    baseDir,
    rules: rules.filter((rule) => inScope(rule.layer)),
    skills: skills.filter((skill) => inScope(skill.layer)),
    warnings,
    cached,
  };
}

export function formatUserRulesText(result: UserRulesResult, detail: UserRulesDetail = "list"): string {
  const lines: string[] = [];
  if (result.rules.length === 0) {
    lines.push("规则链: (无)");
  } else {
    lines.push("规则链:");
    for (const rule of result.rules) {
      const info = [`${Math.max(1, Math.round(rule.bytes / 1024))}KB`];
      if (rule.isSymlink && rule.linkTarget) info.push(`symlink -> ${rule.linkTarget}`);
      if (rule.broken) info.push("⚠️ broken");
      lines.push(`  [${rule.layer}] ${rule.path} (${info.join(", ")})`);
      if (detail === "full" && rule.content !== undefined) {
        lines.push("  内容:");
        for (const line of rule.content.split("\n")) lines.push(`  ${line}`);
      }
    }
  }
  lines.push(`skills (${result.skills.length} 个, 按位置分组):`);
  for (const skill of result.skills) lines.push(`  [${skill.layer}] ${skill.name} — ${skill.description}`);
  lines.push("  → 需要细节请 read_file 对应 SKILL.md");
  if (result.warnings.length > 0) {
    lines.push("警告:");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(home, input.slice(2));
  return input;
}
function isUnder(dir: string, parent: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return dir === parent || dir.startsWith(prefix);
}
function layerName(dir: string, home: string): string {
  if (dir === home) return "~";
  if (isUnder(dir, home)) return "~/" + relative(home, dir).split(sep).join("/");
  return dir;
}
function safeRealpath(abs: string): string {
  try { return realpathSync(abs); } catch { return abs; }
}
function warnBroken(abs: string, display: string, linkTarget: string | undefined, warnings: string[], warned: Set<string>): void {
  if (warned.has(abs)) return;
  warned.add(abs);
  warnings.push(`broken symlink: ${display} -> ${linkTarget ?? ""}`);
}
function inspectRule(abs: string, layer: string, kind: RuleFileEntry["kind"], home: string, detail: UserRulesDetail, warnings: string[], warned: Set<string>): RuleFileEntry | null {
  let lst: ReturnType<typeof lstatSync>;
  try { lst = lstatSync(abs); } catch { return null; }
  const isSymlink = lst.isSymbolicLink();
  let linkTarget: string | undefined;
  if (isSymlink) {
    try { linkTarget = readlinkSync(abs); } catch { /* 读不到目标也照样记录 */ }
  }
  const display = layerName(abs, home);
  let bytes = lst.size;
  let broken = false;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    bytes = st.size;
  } catch {
    broken = true;
    warnBroken(abs, display, linkTarget, warnings, warned);
  }
  const entry: RuleFileEntry = { layer, path: display, realPath: safeRealpath(abs), kind, bytes, isSymlink, broken };
  if (linkTarget !== undefined) entry.linkTarget = linkTarget;
  if (detail === "full" && !broken) {
    try {
      let content = readFileSync(abs, "utf8");
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.slice(0, MAX_CONTENT_CHARS);
        warnings.push(`content truncated: ${display}`);
      }
      entry.content = content;
    } catch { /* 内容不可读时仍保留条目 */ }
  }
  return entry;
}
function parseSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const noFrontmatter = (): { name: string; description: string } => ({
    name: fallbackName, description: firstParagraph(lines.join("\n")),
  });
  if (lines[0] !== "---") return noFrontmatter();
  const end = lines.indexOf("---", 1);
  if (end < 0) return noFrontmatter();
  let name = fallbackName;
  let description = "";
  for (let i = 1; i < end; i += 1) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value === "|" || value === "|-" || value === ">" || value === ">-") {
      const parts: string[] = [];
      while (i + 1 < end && /^\s+/.test(lines[i + 1]!)) {
        i += 1;
        parts.push(lines[i]!.trim());
      }
      value = parts.join(value.startsWith("|") ? "\n" : " ");
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (match[1] === "name" && value) name = value;
    if (match[1] === "description" && value) description = value;
  }
  if (!description) description = firstParagraph(lines.slice(end + 1).join("\n"));
  return { name, description: description.trim() };
}
function firstParagraph(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;
    return trimmed;
  }
  return "";
}
function truncate(text: string): string {
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : text;
}
