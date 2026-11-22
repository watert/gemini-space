import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
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

  function makeTree(): { home: string; proj: string; sub: string } {
    const home = join(sandbox, "home");
    const proj = join(home, "proj");
    const sub = join(proj, "sub");
    ensureDir(sub);
    write(join(home, "AGENTS.md"), "# 家目录规则\nHOME_RULE_SENTENCE\n");
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

  function writeSkill(home: string, name: string, body: string): string {
    const path = join(home, ".agents", "skills", name, "SKILL.md");
    write(path, body);
    return path;
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "gs-user-rules-"));
  });

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("沿路径上溯收集规则，近层规则排在前", async () => {
    const { home, sub } = makeTree();

    const result = await collect({ Path: sub }, runtimeFor(home));

    assert.equal(result.rules.length, 3);
    assert.deepEqual(
      result.rules.map((rule) => rule.layer),
      ["~/proj", "~/proj", "~"],
    );
  });

  it("文件路径入参时 baseDir 为所在目录的 realpath", async () => {
    const { home, proj } = makeTree();

    const result = await collect({ Path: join(proj, "AGENTS.md") }, runtimeFor(home));

    assert.equal(result.baseDir, proj);
  });

  it("realpath 相同的软链接会去重", async () => {
    const { home, proj, sub } = makeTree();
    symlinkSync(join(proj, "AGENTS.md"), join(proj, "AGENTS2.md"));

    const result = await collect({ Path: sub }, runtimeFor(home));

    const realPaths = result.rules.map((rule) => rule.realPath);
    assert.ok(realPaths.length >= 3);
    assert.equal(new Set(realPaths).size, realPaths.length);
  });

  it("断链软链接会产生告警并标记为 broken", async () => {
    const { home } = makeTree();
    const brokenPath = join(home, ".agents", "AGENTS.md");
    ensureDir(dirname(brokenPath));
    symlinkSync(join(sandbox, "missing-target.md"), brokenPath);

    const result = await collect({ Path: home }, runtimeFor(home));

    assert.ok(result.warnings.some((warning) => warning.includes("broken symlink")));
    const brokenEntry = result.rules.find((rule) => rule.broken);
    assert.ok(brokenEntry);
    assert.equal(brokenEntry.broken, true);
    assert.ok(brokenEntry.path.endsWith(join(".agents", "AGENTS.md")));
  });

  it("宽容解析 YAML frontmatter（折叠标量与引号值）", async () => {
    const { home } = makeTree();
    writeSkill(
      home,
      "foo",
      "---\nname: foo\ndescription: >-\n  第一行\n  第二行\n---\n正文",
    );
    writeSkill(home, "bar", '---\nname: "bar"\ndescription: "引号描述"\n---\n正文');

    const result = await collect({ Path: home, IncludeSkills: true }, runtimeFor(home));

    const foo = result.skills.find((skill) => skill.name === "foo");
    assert.ok(foo);
    assert.match(foo.description, /第一行/);
    assert.match(foo.description, /第二行/);
    const bar = result.skills.find((skill) => skill.name === "bar");
    assert.ok(bar);
    assert.match(bar.description, /引号描述/);
  });

  it("Query 命中 name 的 skills 得 100 分并排在前面", async () => {
    const { home } = makeTree();
    writeSkill(home, "token-skill", '---\nname: token-skill\ndescription: "与 token 相关"\n---\n正文');
    writeSkill(home, "plain-skill", '---\nname: plain-skill\ndescription: "普通说明"\n---\n正文');

    const result = await collect(
      { Path: home, IncludeSkills: true, Query: "token" },
      runtimeFor(home),
    );

    assert.equal(result.skills.length, 2);
    assert.equal(result.skills[0].name, "token-skill");
    assert.equal(result.skills[0].score, 100);
  });

  it("IncludeSkills=false 时不返回 skills", async () => {
    const { home } = makeTree();
    writeSkill(home, "hidden-skill", '---\nname: hidden-skill\ndescription: "说明"\n---\n正文');

    const result = await collect({ Path: home, IncludeSkills: false }, runtimeFor(home));

    assert.deepEqual(result.skills, []);
  });

  it("Detail=full 时规则带 content，缺省时不带", async () => {
    const { home, proj } = makeTree();
    write(join(proj, "AGENTS.md"), "UNIQUE_AGENTS_SENTENCE_2026\n");

    const full = await collect({ Path: proj, Detail: "full" }, runtimeFor(home));
    const fullEntry = full.rules.find(
      (rule) => rule.realPath === realpathSync(join(proj, "AGENTS.md")),
    );
    assert.ok(fullEntry);
    assert.ok(fullEntry.content?.includes("UNIQUE_AGENTS_SENTENCE_2026"));

    const list = await collect({ Path: proj }, runtimeFor(home));
    assert.ok(list.rules.length > 0);
    assert.ok(list.rules.every((rule) => rule.content === undefined));
  });

  it("list 模式把过长的 description 截断到 161 字以内", async () => {
    const { home } = makeTree();
    writeSkill(
      home,
      "long-skill",
      `---\nname: long-skill\ndescription: "${"描述".repeat(150)}"\n---\n正文`,
    );

    const result = await collect({ Path: home, IncludeSkills: true }, runtimeFor(home));

    const entry = result.skills.find((skill) => skill.name === "long-skill");
    assert.ok(entry);
    assert.ok(entry.description.length <= 161);
    assert.ok(entry.description.endsWith("…"));
  });

  it("同一路径重复调用命中缓存，SKILL.md 变化后缓存失效", async () => {
    const { home } = makeTree();
    const skillPath = writeSkill(
      home,
      "cached-skill",
      '---\nname: cached-skill\ndescription: "旧描述"\n---\n正文',
    );
    const options: UserRulesOptions = { Path: home, IncludeSkills: true };
    const runtime = runtimeFor(home);

    const first = await collect(options, runtime);
    const second = await collect(options, runtime);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);

    // 显式推进 mtime，避免文件系统时间粒度导致缓存无法发现变化。
    write(skillPath, '---\nname: cached-skill\ndescription: "新描述"\n---\n正文');
    const newer = new Date(Date.now() + 10_000);
    utimesSync(skillPath, newer, newer);

    const third = await collect(options, runtime);
    assert.equal(third.cached, false);
    const entry = third.skills.find((skill) => skill.name === "cached-skill");
    assert.ok(entry);
    assert.match(entry.description, /新描述/);
  });

  it("allowedRoots 之外的路径会被拒绝", async () => {
    const { home, proj } = makeTree();

    await assert.rejects(
      collect({ Path: home }, runtimeFor(home, { allowedRoots: [proj] })),
    );
  });

  it("formatUserRulesText 输出规则链、skills 摘要与警告", async () => {
    const { home, proj } = makeTree();
    writeSkill(home, "format-skill", '---\nname: format-skill\ndescription: "用于格式化"\n---\n正文');

    const cleanResult = await collect({ Path: proj, IncludeSkills: true }, runtimeFor(home));
    const cleanText = formatUserRulesText(cleanResult);
    assert.ok(cleanText.includes("规则链:"));
    assert.ok(cleanText.includes("skills ("));
    assert.ok(cleanText.trimEnd().endsWith("→ 需要细节请 read_file 对应 SKILL.md"));

    // 断链单独放一轮，避免警告段落出现在 skills 提示之后。
    const brokenPath = join(home, ".agents", "AGENTS.md");
    ensureDir(dirname(brokenPath));
    symlinkSync(join(sandbox, "missing-target.md"), brokenPath);
    const warnedResult = await collect({ Path: home, IncludeSkills: true }, runtimeFor(home));
    assert.ok(warnedResult.warnings.length > 0, "测试前提：应产生告警");
    assert.ok(formatUserRulesText(warnedResult).includes("警告:"));
  });
});
