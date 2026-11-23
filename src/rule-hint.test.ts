import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgyBridge } from "./agy-bridge.js";
import { extractCommandPaths, RuleHintTracker } from "./rule-hint.js";

function makeHome(t: TestContext): { sandbox: string; home: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "gs-rule-hint-"));
  const home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, home };
}

function hintFor(displayRoot: string): string {
  return `\n[rules] ${displayRoot} has project rules — call user_rules(Path: "${displayRoot}") for AGENTS.md and skills.`;
}

test("hints a directory with AGENTS.md once per root", (t) => {
  const { home } = makeHome(t);
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# rules\n");

  const tracker = new RuleHintTracker(home);
  const expected = hintFor("~/proj");
  assert.equal(tracker.probe(proj), expected);
  // 重复目录、同 root 下的不存在路径与文件路径都不再提示。
  assert.equal(tracker.probe(join(proj, "nested", "missing.txt")), null);
  assert.equal(tracker.probe(join(proj, "AGENTS.md")), null);
});

test("returns null for directories without rule markers", (t) => {
  const { home } = makeHome(t);
  const plain = join(home, "plain");
  mkdirSync(plain, { recursive: true });

  assert.equal(new RuleHintTracker(home).probe(plain), null);
});

test("resolves a file path to its containing directory before probing", (t) => {
  const { home } = makeHome(t);
  const proj = join(home, "file-root");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# rules\n");
  const file = join(proj, "note.txt");
  writeFileSync(file, "hello\n");

  assert.equal(new RuleHintTracker(home).probe(file), hintFor("~/file-root"));
});

test("prefers the nearest rule root for nested directories", (t) => {
  const { home } = makeHome(t);
  const outer = join(home, "outer");
  const inner = join(outer, "inner");
  const deep = join(inner, "a", "b");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(outer, "AGENTS.md"), "# outer rules\n");
  mkdirSync(join(inner, ".agents", "skills"), { recursive: true });

  assert.equal(new RuleHintTracker(home).probe(deep), hintFor("~/outer/inner"));
});

test("markHinted suppresses subsequent probe for the same rule root", (t) => {
  const { home } = makeHome(t);
  const proj = join(home, "marked");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# rules\n");

  const tracker = new RuleHintTracker(home);
  tracker.markHinted(proj);
  assert.equal(tracker.probe(join(proj, "sub", "file.ts")), null);
});

test("persists hinted roots across instances within TTL and expires afterwards", (t) => {
  const { sandbox, home } = makeHome(t);
  const proj = join(home, "persist");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# rules\n");
  const statePath = join(sandbox, "state", "rule-hints.json");

  let clock = 1_000_000;
  const now = () => clock;

  const first = new RuleHintTracker(home, { statePath, ttlMs: 60_000, now });
  assert.equal(first.probe(proj), hintFor("~/persist"));

  // 模拟子进程重启：在 TTL 内新建 tracker 不重复提示。
  clock += 30_000;
  const second = new RuleHintTracker(home, { statePath, ttlMs: 60_000, now });
  assert.equal(second.probe(proj), null);

  // 超过 TTL 后恢复提示（适配 stdio 固定 sessionUuid 的新对话）。
  clock += 31_000;
  const third = new RuleHintTracker(home, { statePath, ttlMs: 60_000, now });
  assert.equal(third.probe(proj), hintFor("~/persist"));
});

test("extractCommandPaths and probeCommand detect target repo paths and fallback to workspace", (t) => {
  const { home } = makeHome(t);
  const ws = join(home, "ws");
  const repo = join(home, "repo");
  mkdirSync(ws, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# ws\n");
  writeFileSync(join(repo, "AGENTS.md"), "# repo\n");

  assert.deepEqual(extractCommandPaths("curl https://example.com/a/b && ls /tmp/foo"), ["/tmp/foo"]);

  const tracker = new RuleHintTracker(home);
  // 命令行显式指向 repo 时，提示 repo 而不误弹 fallback workspace。
  assert.equal(tracker.probeCommand(`git -C ${repo} status`, ws), hintFor("~/repo"));
  assert.equal(tracker.probeCommand(`git -C ${repo} log`, ws), null);

  // 命令行无本地路径时，回退到 workspace。
  assert.equal(tracker.probeCommand("echo ok", ws), hintFor("~/ws"));
  assert.equal(tracker.probeCommand("echo ok", ws), null);
});

test("AgyBridge isolates rule hints per session and suppresses hint after user_rules", async (t) => {
  const { sandbox } = makeHome(t);
  const ws = join(sandbox, "ws");
  const agyHome = join(sandbox, "agy-home");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "AGENTS.md"), "# ws rules\n");
  const file = join(ws, "hello.txt");
  writeFileSync(file, "hi\n");

  const bridge = new AgyBridge(
    {
      bin: "agy",
      agyHome,
      workspace: ws,
      modelId: "test",
      wireProtocol: "genai",
      holdMs: 5_000,
      callTimeoutMs: 10_000,
      sessionIdleTtlMs: 60_000,
      warnToolCallsPerSession: 0,
      exposedTools: ["read_file", "write_file", "edit_file", "run_command", "manage_task"],
    },
    {
      level: "error",
      format: "pretty",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  );
  await bridge.start();
  t.after(() => bridge.close());

  const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
    res.content.map((b) => b.text ?? "").join("");

  // Session A 首次 read_file 收到提示，二次不重复。
  const a1 = await bridge.callTool("sess-a", "read_file", { Path: file });
  assert.match(textOf(a1), /\[rules\] .* has project rules/);
  const a2 = await bridge.callTool("sess-a", "read_file", { Path: file });
  assert.doesNotMatch(textOf(a2), /\[rules\]/);

  // Session B 独立隔离，仍能收到首次提示。
  const b1 = await bridge.callTool("sess-b", "read_file", { Path: file });
  assert.match(textOf(b1), /\[rules\] .* has project rules/);

  // Session C 先调 user_rules，紧接着 read_file 不应再弹提示。
  await bridge.callTool("sess-c", "user_rules", { Path: ws });
  const c1 = await bridge.callTool("sess-c", "read_file", { Path: file });
  assert.doesNotMatch(textOf(c1), /\[rules\]/);
});
