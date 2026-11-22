import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { collectUserRules, formatUserRulesText } from "./user-rules.js";
import type { UserRulesOptions, UserRulesResult, UserRulesRuntime } from "./user-rules.js";

describe("collectUserRules / formatUserRulesText", () => {
  let sandbox = "";

  // 所有测试只在临时沙箱里造文件，绝不访问真实家目录。
  function ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  function write(path: string, content: string): void {
    ensureDir(dirname(path));
    writeFileSync(path, content, "utf8");
  }

  // 家级规则固定在 ~/.agents/AGENTS.md；项目级放在 proj 根。
  function makeTree(): { home: string; proj: string; sub: string } {
    const home = join(sandbox, "home");
    const proj = join(home, "proj");
    const sub = join(proj, "sub");
    ensureDir(sub);
    write(join(home, ".agents", "AGENTS.md"), "# 用户规则\nHOME_RULE_SENTENCE\n");
    write(join(proj, "AGENTS.md"), "# 项目规则\nPROJ_RULE_SENTENCE\n");
    write(join(proj, "CLAUDE.md"), "# Claude 规则\nCLAUDE_RULE_SENTENCE\n");
    return { home, proj, sub };
  }

  function runtimeFor(
    home: string,
    extra: Omit<Partial<UserRulesRuntime>, "homeDir"> = {},
  ): UserRulesRuntime {
    return { ...extra, homeDir: home };
  }

  function collect(options: UserRulesOptions, runtime: UserRulesRuntime): Promise<UserRulesResult> {
    return collectUserRules(options, runtime);
  }

  function writeSkill(root: string, name: string, body: string): string {
    const path = join(root, ".agents", "skills", name, "SKILL.md");
    write(path, body);
    return path;
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "gs-user-rules-"));
  });

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("用户级与目录级规则分成两段，目录级只取最近的一个根", async () => {
    const { home, proj, sub } = makeTree();

    const result = await collect({ Path: sub }, runtimeFor(home));

    assert.equal(result.user.root, "~");
    assert.equal(result.user.rules.length, 1);
    assert.ok(result.user.rules[0]!.path.endsWith(join(".agents", "AGENTS.md")));

    assert.equal(result.dir?.root, "~/proj");
    assert.deepEqual(
      result.dir?.rules.map((rule) => rule.path),
      [join("~/proj", "AGENTS.md"), join("~/proj", "CLAUDE.md")],
    );
  });

  it("上溯在第一个含规则标记的目录停止，不会再拿到更上层的 AGENTS.md", async () => {
    const { home, proj, sub } = makeTree();
    // home 根也放一个 AGENTS.md，它不该出现在目录级结果里。
    write(join(home, "AGENTS.md"), "# 家目录根规则\nSHOULD_NOT_APPEAR\n");

    const result = await collect({ Path: sub }, runtimeFor(home));

    assert.equal(result.dir?.root, "~/proj");
    const all = result.dir?.rules.map((rule) => rule.path).join(",") ?? "";
    assert.equal(all.includes("SHOULD_NOT_APPEAR"), false);
    assert.equal(all.includes(join("~", "AGENTS.md")), false);
  });

  it("文件路径入参时 baseDir 为所在目录", async () => {
    const { home, proj } = makeTree();

    const result = await collect({ Path: join(proj, "AGENTS.md") }, runtimeFor(home));

    assert.equal(result.baseDir, proj);
  });

  it("同一 SKILL.md 经 .agents 与 .claude 两条路径只会出现一次", async () => {
    const { home } = makeTree();
    writeSkill(home, "foo", '---\nname: foo\ndescription: "唯一技能"\n---\n正文');
    ensureDir(join(home, ".claude", "skills"));
    symlinkSync(join(home, ".agents", "skills", "foo"), join(home, ".claude", "skills", "foo"));

    const result = await collect({ Path: home }, runtimeFor(home));

    const foos = result.user.skills.filter((skill) => skill.name === "foo");
    assert.equal(foos.length, 1);
  });

  it("断链软链接会产生告警并标记为 broken", async () => {
    const { home } = makeTree();
    const brokenPath = join(home, ".agents", "AGENTS.md");
    rmSync(brokenPath);
    symlinkSync(join(sandbox, "missing-target.md"), brokenPath);

    const result = await collect({ Path: home }, runtimeFor(home));

    assert.ok(result.warnings.some((warning) => warning.includes("broken symlink")));
    const brokenEntry = result.user.rules.find((rule) => rule.broken);
    assert.ok(brokenEntry);
    assert.equal(brokenEntry.broken, true);
    assert.ok(brokenEntry.path.endsWith(join(".agents", "AGENTS.md")));
  });

  it("宽容解析 YAML frontmatter（折叠标量与引号值）", async () => {
    const { home } = makeTree();
    writeSkill(home, "foo", "---\nname: foo\ndescription: >-\n  第一行\n  第二行\n---\n正文");
    writeSkill(home, "bar", '---\nname: "bar"\ndescription: "引号描述"\n---\n正文');

    const result = await collect({ Path: home }, runtimeFor(home));

    const foo = result.user.skills.find((skill) => skill.name === "foo");
    const bar = result.user.skills.find((skill) => skill.name === "bar");
    assert.ok(foo);
    assert.match(foo.description, /第一行/);
    assert.match(foo.description, /第二行/);
    assert.equal(bar?.description, "引号描述");
  });

  it("Query 命中的 skill 排在同一段的最前面", async () => {
    const { home } = makeTree();
    writeSkill(home, "alpha", '---\nname: alpha\ndescription: "普通技能"\n---\n正文');
    writeSkill(home, "beta", '---\nname: beta\ndescription: "token 统计"\n---\n正文');

    const result = await collect({ Path: home, Query: "token" }, runtimeFor(home));

    assert.equal(result.user.skills[0]?.name, "beta");
    assert.equal(result.user.skills[0]?.score, 100);
  });

  it("IncludeSkills=false 时两段都不给 skills", async () => {
    const { home, proj } = makeTree();
    writeSkill(home, "hidden-skill", '---\nname: hidden-skill\ndescription: "说明"\n---\n正文');

    const result = await collect({ Path: proj, IncludeSkills: false }, runtimeFor(home));

    assert.deepEqual(result.user.skills, []);
    assert.deepEqual(result.dir?.skills, []);
  });

  it("Detail=full 时规则带 content，缺省时只给 head 预览", async () => {
    const { home, proj } = makeTree();
    write(join(proj, "AGENTS.md"), "UNIQUE_AGENTS_SENTENCE_2026\n");

    const full = await collect({ Path: proj, Detail: "full" }, runtimeFor(home));
    const fullEntry = full.dir?.rules.find((rule) => rule.path.endsWith("AGENTS.md"));
    assert.ok(fullEntry);
    assert.ok(fullEntry.content?.includes("UNIQUE_AGENTS_SENTENCE_2026"));

    const list = await collect({ Path: proj }, runtimeFor(home));
    const listEntry = list.dir?.rules.find((rule) => rule.path.endsWith("AGENTS.md"));
    assert.ok(listEntry);
    assert.equal(listEntry.content, undefined);
    assert.ok(listEntry.head?.includes("UNIQUE_AGENTS_SENTENCE_2026"));
  });

  it("head 预览压成单行并截到 200 字以内", async () => {
    const { home, proj } = makeTree();
    write(join(proj, "AGENTS.md"), `# 标题\n\n${"长内容 ".repeat(120)}\n`);

    const result = await collect({ Path: proj }, runtimeFor(home));
    const entry = result.dir?.rules.find((rule) => rule.path.endsWith("AGENTS.md"));

    assert.ok(entry?.head);
    assert.ok(entry.head.length <= 200);
    assert.equal(entry.head.includes("\n"), false);
    assert.ok(entry.head.endsWith("…"));
  });

  it("list 模式把过长的 skill 描述截断", async () => {
    const { home } = makeTree();
    writeSkill(
      home,
      "long-skill",
      `---\nname: long-skill\ndescription: "${"描述".repeat(150)}"\n---\n正文`,
    );

    const result = await collect({ Path: home, IncludeSkills: true }, runtimeFor(home));

    const entry = result.user.skills.find((skill) => skill.name === "long-skill");
    assert.ok(entry);
    assert.ok(entry.description.length <= 161);
    assert.ok(entry.description.endsWith("…"));
  });

  it("SKILL.md 解析结果按 mtime 缓存，内容变化后失效", async () => {
    const { home } = makeTree();
    const skillPath = writeSkill(
      home,
      "cached-skill",
      '---\nname: cached-skill\ndescription: "旧描述"\n---\n正文',
    );
    const options: UserRulesOptions = { Path: home };
    const runtime = runtimeFor(home);

    const first = await collect(options, runtime);
    assert.equal(first.cached, false);
    const second = await collect(options, runtime);
    assert.equal(second.cached, true);

    write(skillPath, '---\nname: cached-skill\ndescription: "新描述"\n---\n正文');
    const newer = new Date(Date.now() + 10_000);
    utimesSync(skillPath, newer, newer);

    const third = await collect(options, runtime);
    assert.equal(third.cached, false);
    assert.match(third.user.skills.find((skill) => skill.name === "cached-skill")?.description ?? "", /新描述/);
  });

  it("allowedRoots 之外的路径会被拒绝", async () => {
    const { home, proj } = makeTree();

    await assert.rejects(
      collect({ Path: home }, runtimeFor(home, { allowedRoots: [proj] })),
    );
  });

  it("formatUserRulesText 输出四个段落与读全文指示", async () => {
    const { home, proj } = makeTree();
    writeSkill(home, "format-skill", '---\nname: format-skill\ndescription: "用于格式化"\n---\n正文');
    const brokenPath = join(home, ".agents", "AGENTS.md");
    rmSync(brokenPath);
    symlinkSync(join(sandbox, "missing-target.md"), brokenPath);

    const result = await collect({ Path: join(proj, "AGENTS.md") }, runtimeFor(home));
    const text = formatUserRulesText(result);

    assert.ok(text.includes("## 1. User rules"));
    assert.ok(text.includes("## 2. User skills ("));
    assert.ok(text.includes("## 3. Directory rules (root: ~/proj)"));
    assert.ok(text.includes("## 4. Directory skills ("));
    assert.ok(text.includes("→ read_file"));
    assert.ok(text.includes("→ 需要细节请 read_file 对应 SKILL.md"));
    assert.ok(result.warnings.length > 0, "测试前提：应产生告警");
    assert.ok(text.includes("## Warnings"));
  });

  it("Path 在 home 且无目录标记时只给用户级段落", async () => {
    const { home } = makeTree();

    const result = await collect({ Path: home }, runtimeFor(home));

    assert.equal(result.dir, null);
    const text = formatUserRulesText(result);
    assert.ok(text.includes("## 3. Directory rules"));
    assert.ok(text.includes("## 4. Directory skills (0)"));
  });
});
