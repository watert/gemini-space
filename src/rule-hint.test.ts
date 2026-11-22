import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { RuleHintTracker } from "./rule-hint.js";

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
