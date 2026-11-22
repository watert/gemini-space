/**
 * 用户规则拉取工具（pull 模型）。
 *
 * 设计取向是「harness context」：返回的不是全量文本，而是一份分层目录 ——
 * 每层给「路径 + 元信息 + 200 字预览 + 读全文的指示」，让模型自己决定要不要 read_file。
 * 因此这里刻意做两件事：
 *   1. 上溯只走到第一个含规则标记的目录就停（不是一路递归到 /）；
 *   2. rules 与 skills 分成 user / dir 两段，各自独立成节。
 * 目录枚举每次实时进行，仅 SKILL.md 的解析结果按 mtime/size 缓存。
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
  /** list 模式的前 200 字预览（压成单行）。 */
  head?: string;
  /** full 模式的完整正文。 */
  content?: string;
}
export interface SkillEntry {
  layer: string;
  name: string;
  description: string;
  path: string;
  score: number;
}
export interface RulesSection {
  label: "user" | "dir";
  root: string | null;
  rules: RuleFileEntry[];
  skills: SkillEntry[];
}
export interface UserRulesResult {
  requestedPath: string;
  baseDir: string;
  user: RulesSection;
  dir: RulesSection | null;
  warnings: string[];
  cached: boolean;
}

const MAX_DESCRIPTION_CHARS = 160;
const MAX_HEAD_CHARS = 200;
const MAX_CONTENT_CHARS = 200_000;
const RULE_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILL_DIRS = [".agents/skills", ".claude/skills"] as const;

interface SkillMeta {
  mtimeMs: number;
  size: number;
  name: string;
  description: string;
  raw?: string;
}
const skillCache = new Map<string, SkillMeta>();
const KNOWN_BROKEN_PATHS = [
  ".agents/AGENTS.md",
  "docs/scripts",
  "docs/htmls",
  "docs/tmp",
  "docs/refs",
  "docs/posts-zhihu",
  "docs/post-topics",
] as const;

export async function collectUserRules(
  options: UserRulesOptions,
  runtime: UserRulesRuntime,
): Promise<UserRulesResult> {
  // 展示路径保留未解析软链的原始形式（~/docs 比 iCloud 长路径可读得多），
  // realpath 只用于去重、判活与边界检查。
  const home = resolve(runtime.homeDir);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const requestedPath = options.Path ?? "";
  const detail = options.Detail ?? "list";
  const scope: UserRulesScope = options.Scope ?? "auto";

  const { baseDir, pathWarning } = resolveBaseDir(requestedPath, home);
  if (pathWarning) warnings.push(pathWarning);

  if (runtime.allowedRoots?.length) {
    // 边界判定走 realpath，防止软链把路径绕出白名单。
    const realBase = safeRealpath(baseDir);
    const inside = runtime.allowedRoots.some((root) =>
      isUnder(realBase, safeRealpath(resolve(expandHome(root, home)))),
    );
    if (!inside) throw new Error("path is outside allowed roots: " + baseDir);
  }

  const includeSkills = options.IncludeSkills !== false;
  const query = options.Query?.trim().toLowerCase() ?? "";
  let cached = true;

  // ── 1/2. 用户级：固定的 ~/.agents/AGENTS.md 与用户级 skills 目录 ──
  const userRules: RuleFileEntry[] = [];
  const seenRules = new Set<string>();
  const homeAgents = join(home, ".agents", "AGENTS.md");
  const userEntry = inspectRule(homeAgents, "~", "agents", home, detail, warnings, warned);
  if (userEntry && !seenRules.has(userEntry.realPath)) {
    seenRules.add(userEntry.realPath);
    userRules.push(userEntry);
  }

  const userSkillDirs: Array<{ path: string; layer: string }> = [
    { path: join(home, ".agents", "skills"), layer: "~" },
    { path: join(home, ".claude", "skills"), layer: "~" },
  ];
  for (const extra of runtime.skillsPaths ?? []) {
    const dir = resolve(expandHome(extra, home));
    userSkillDirs.push({ path: dir, layer: layerName(dir, home) });
  }
  const userSkills = includeSkills
    ? collectSkills(userSkillDirs, query, detail)
    : { skills: [] as SkillEntry[], cached: true };
  cached &&= userSkills.cached;

  // ── 3/4. 目录级：向上找第一个含规则标记的目录，命中即停 ──
  let dir: RulesSection | null = null;
  if (requestedPath.trim() !== "" || scope === "project") {
    const root = findRuleRoot(baseDir, home);
    if (root) {
      const layer = layerName(root, home);
      const dirRules: RuleFileEntry[] = [];
      for (const filename of RULE_FILENAMES) {
        const kind: RuleFileEntry["kind"] = filename === "CLAUDE.md" ? "claude" : "agents";
        const entry = inspectRule(join(root, filename), layer, kind, home, detail, warnings, warned);
        if (entry && !seenRules.has(entry.realPath)) {
          seenRules.add(entry.realPath);
          dirRules.push(entry);
        }
      }
      // my-codes 的 README 是接线清单，按规则文件对待。
      if (basename(root) === "my-codes") {
        const readme = inspectRule(join(root, "README.md"), layer, "readme", home, detail, warnings, warned);
        if (readme && !seenRules.has(readme.realPath)) {
          seenRules.add(readme.realPath);
          dirRules.push(readme);
        }
      }
      const dirSkillDirs = SKILL_DIRS.map((rel) => ({
        path: join(root, ...rel.split("/")),
        layer,
      }));
      const dirSkills = includeSkills
        ? collectSkills(dirSkillDirs, query, detail)
        : { skills: [] as SkillEntry[], cached: true };
      cached &&= dirSkills.cached;
      dir = { label: "dir", root: layer, rules: dirRules, skills: dirSkills.skills };
    }
  }

  for (const rel of KNOWN_BROKEN_PATHS) {
    const target = join(home, ...rel.split("/"));
    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(target);
    } catch {
      continue;
    }
    if (!lst.isSymbolicLink()) continue;
    let linkTarget = "";
    try {
      linkTarget = readlinkSync(target);
      statSync(target);
    } catch {
      warnBroken(target, layerName(target, home), linkTarget, warnings, warned);
    }
  }

  const emptyUser: RulesSection = { label: "user", root: home === baseDir ? "~" : "~", rules: [], skills: [] };
  const user: RulesSection =
    scope === "project"
      ? emptyUser
      : { label: "user", root: "~", rules: userRules, skills: userSkills.skills };

  return {
    requestedPath,
    baseDir,
    user,
    dir: scope === "user" ? null : dir,
    warnings,
    cached,
  };
}

export function formatUserRulesText(result: UserRulesResult, detail: UserRulesDetail = "list"): string {
  const lines: string[] = [];
  appendRules(lines, "## 1. User rules", result.user, detail, "~/.agents/AGENTS.md");
  appendSkills(lines, `## 2. User skills (${result.user.skills.length})`, result.user.skills);

  if (result.dir) {
    const rootLabel = result.dir.root ?? "(unknown)";
    appendRules(lines, `## 3. Directory rules (root: ${rootLabel})`, result.dir, detail, null);
    appendSkills(lines, `## 4. Directory skills (${result.dir.skills.length})`, result.dir.skills);
  } else {
    lines.push("## 3. Directory rules");
    lines.push(`(未在 ${result.baseDir} 的上溯链中找到 AGENTS.md / CLAUDE.md / skills 目录)`);
    lines.push("## 4. Directory skills (0)");
    lines.push("(无)");
  }

  if (result.warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

/** 规则段：路径 + 元信息 + head 预览 + 读全文指示（full 模式直接给正文）。 */
function appendRules(
  lines: string[],
  title: string,
  section: RulesSection | null,
  detail: UserRulesDetail,
  fallbackHintPath: string | null,
): void {
  lines.push(title);
  if (!section || section.rules.length === 0) {
    lines.push("(无)");
    return;
  }
  for (const rule of section.rules) {
    const info = [`${Math.max(1, Math.round(rule.bytes / 1024))}KB`];
    if (rule.isSymlink && rule.linkTarget) info.push(`symlink -> ${rule.linkTarget}`);
    if (rule.broken) info.push("⚠️ broken");
    lines.push(`- ${rule.path} (${info.join(", ")})`);
    if (detail === "full" && rule.content !== undefined) {
      lines.push("  内容:");
      for (const line of rule.content.split("\n")) lines.push(`  ${line}`);
    } else if (rule.head) {
      lines.push(`  head: ${rule.head}`);
      lines.push(`  → read_file "${rule.path}" 读取全文`);
    } else {
      lines.push(`  → read_file "${rule.path}" 读取全文`);
    }
  }
  if (detail !== "full" && fallbackHintPath && section.rules.length > 1) {
    lines.push(`  （以上内容需要展开时，用 read_file 逐个打开）`);
  }
}

/** skills 段：name — 一句话描述 + SKILL.md 路径（不贴正文）。 */
function appendSkills(lines: string[], title: string, skills: readonly SkillEntry[]): void {
  lines.push(title);
  if (skills.length === 0) {
    lines.push("(无)");
    return;
  }
  for (const skill of skills) {
    lines.push(`- ${skill.name} — ${skill.description}`);
    lines.push(`  ${skill.path}`);
  }
  lines.push("→ 需要细节请 read_file 对应 SKILL.md");
}

function collectSkills(
  dirs: ReadonlyArray<{ path: string; layer: string }>,
  query: string,
  detail: UserRulesDetail,
): { skills: SkillEntry[]; cached: boolean } {
  const skills: SkillEntry[] = [];
  const seen = new Set<string>();
  let cached = true;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir.path).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      const skillFile = join(dir.path, name, "SKILL.md");
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(skillFile);
      } catch {
        continue;
      }
      const real = safeRealpath(skillFile);
      if (seen.has(real)) continue;
      seen.add(real);
      const hit = skillCache.get(real);
      let meta: SkillMeta;
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        meta = hit;
      } else {
        cached = false;
        let raw: string;
        try {
          raw = readFileSync(skillFile, "utf8");
        } catch {
          continue;
        }
        const parsed = parseSkillMarkdown(raw, name);
        meta = { mtimeMs: st.mtimeMs, size: st.size, ...parsed, raw };
        skillCache.set(real, meta);
      }
      const description = detail === "list" ? truncate(meta.description) : meta.description;
      const matched =
        query !== "" &&
        (meta.name.toLowerCase().includes(query) || meta.description.toLowerCase().includes(query));
      skills.push({
        layer: dir.layer,
        name: meta.name,
        description,
        path: skillFile,
        score: matched ? 100 : 0,
      });
    }
  }
  if (query) skills.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { skills, cached };
}

function resolveBaseDir(
  requestedPath: string,
  home: string,
): { baseDir: string; pathWarning?: string } {
  if (!requestedPath.trim()) return { baseDir: home };
  const target = resolve(expandHome(requestedPath, home));
  let st: ReturnType<typeof statSync> | undefined;
  try {
    st = statSync(target);
  } catch {
    // 路径不存在时仍按它上溯：父目录可能挂着规则。
  }
  if (!st) return { baseDir: target, pathWarning: `path does not exist: ${requestedPath}` };
  return { baseDir: st.isFile() ? dirname(target) : target };
}

/** 含规则标记即视为规则根；命中第一个就停止上溯。 */
export function findRuleRoot(baseDir: string, home: string): string | null {
  for (let dir = baseDir; ; dir = dirname(dir)) {
    // home 本身由 user 段负责，避免两段重复。
    if (dir === home) return null;
    if (hasRuleMarker(dir)) return dir;
    if (dir === dirname(dir)) return null;
  }
}

export function hasRuleMarker(dir: string): boolean {
  for (const filename of RULE_FILENAMES) {
    try {
      if (statSync(join(dir, filename)).isFile()) return true;
    } catch {
      // 不存在就继续找下一个标记。
    }
  }
  if (basename(dir) === "my-codes") {
    try {
      if (statSync(join(dir, "README.md")).isFile()) return true;
    } catch {
      // 同上。
    }
  }
  for (const rel of SKILL_DIRS) {
    try {
      if (statSync(join(dir, ...rel.split("/"))).isDirectory()) return true;
    } catch {
      // 同上。
    }
  }
  return false;
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
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
function warnBroken(
  abs: string,
  display: string,
  linkTarget: string | undefined,
  warnings: string[],
  warned: Set<string>,
): void {
  if (warned.has(abs)) return;
  warned.add(abs);
  warnings.push(`broken symlink: ${display} -> ${linkTarget ?? ""}`);
}
function inspectRule(
  abs: string,
  layer: string,
  kind: RuleFileEntry["kind"],
  home: string,
  detail: UserRulesDetail,
  warnings: string[],
  warned: Set<string>,
): RuleFileEntry | null {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(abs);
  } catch {
    return null;
  }
  const isSymlink = lst.isSymbolicLink();
  let linkTarget: string | undefined;
  if (isSymlink) {
    try {
      linkTarget = readlinkSync(abs);
    } catch {
      // 读不到目标也照样记条目，交由 broken 标记说明。
    }
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
  const entry: RuleFileEntry = {
    layer,
    path: display,
    realPath: safeRealpath(abs),
    kind,
    bytes,
    isSymlink,
    broken,
  };
  if (linkTarget !== undefined) entry.linkTarget = linkTarget;
  if (broken) return entry;
  try {
    const raw = readFileSync(abs, "utf8");
    if (detail === "full") {
      entry.content = raw.length > MAX_CONTENT_CHARS ? raw.slice(0, MAX_CONTENT_CHARS) : raw;
      if (raw.length > MAX_CONTENT_CHARS) warnings.push(`content truncated: ${display}`);
    } else {
      const flattened = raw.replace(/\s+/g, " ").trim();
      entry.head =
        flattened.length > MAX_HEAD_CHARS ? `${flattened.slice(0, MAX_HEAD_CHARS - 1)}…` : flattened;
    }
  } catch {
    // 内容不可读时仍保留条目。
  }
  return entry;
}
function parseSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const noFrontmatter = (): { name: string; description: string } => ({
    name: fallbackName,
    description: firstParagraph(lines.join("\n")),
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
