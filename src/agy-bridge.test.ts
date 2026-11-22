import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgyBridge } from "./agy-bridge.js";
import { devspaceConfigSchema } from "./config-schema.js";
import type { ServerConfig } from "./config.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { cleanGeminiToolSchema } from "./schema-clean.js";
import { createServer } from "./server.js";

// Minimal valid 1x1 red PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("schema cleaner strips Gemini-incompatible keywords and lowercases types", () => {
  const dirty = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "OBJECT",
    additionalProperties: false,
    properties: {
      Path: { type: "STRING", description: "Absolute path" },
      Count: { type: "INTEGER", exclusiveMinimum: 0, maximum: 9_999_999_999 },
      Mode: { const: "status" },
    },
    required: ["Path"],
  };

  const cleaned = cleanGeminiToolSchema(dirty);
  assert.equal("$schema" in cleaned, false);
  assert.equal("additionalProperties" in cleaned, false);
  assert.equal(cleaned.type, "object");

  const props = cleaned.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.Path?.type, "string");
  assert.equal(props.Count?.type, "integer");
  assert.equal(props.Count?.minimum, 1);
  assert.equal("maximum" in (props.Count ?? {}), false);
  assert.deepEqual(props.Mode?.enum, ["status"]);
});

test("config schema accepts legacy Synrex keys and defaults refreshTokenGraceSeconds to 300", () => {
  const parsed = devspaceConfigSchema.parse({
    configVersion: 1,
    server: {
      host: "127.0.0.1",
      port: 7676,
      publicBaseUrl: "https://example.ts.net",
    },
    node: { alias: null, labels: {} },
    cluster: { role: "standalone" },
    workspaces: { allowedRoots: ["/Users/test"] },
    storage: { stateDir: "~/.local/share/devspace", metadataRetentionDays: 90 },
    tools: { mode: "codex" },
  });

  assert.equal(parsed.oauth.refreshTokenGraceSeconds, 300);
  assert.deepEqual(parsed.agy.exposedTools, [
    "read_file",
    "write_file",
    "edit_file",
    "run_command",
    "manage_task",
  ]);
});

test(
  "end-to-end AGY MCP bridge: tools, PNG read, multi-subagent concurrency, 10s+ single-call hold, and session isolation",
  async (t: TestContext) => {
    const root = await mkdtemp(join(tmpdir(), "devspace-agy-e2e-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const stateDir = join(root, "state");
    const agyHome = join(root, "agy-home");
    const workspace = join(root, "workspace");
    const customSkillsDir = join(root, "custom-skills");
    await mkdir(join(customSkillsDir, "demo-skill"), { recursive: true });
    await writeFile(
      join(customSkillsDir, "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill for E2E verification\n---\n# Demo\n",
    );

    // Start HTTP server with holdMs = 6000ms so we can test both:
    //   1) a command exceeding WaitMsBeforeAsync (1s -> finishes at 2.5s <= 6s holdMs) returning in ONE call, and
    //   2) a command exceeding holdMs (finishes at 8.5s > 6s holdMs) returning a TaskId and completing via manage_task(status).
    const ownerToken = "test-owner-password-at-least-16-chars";
    const baseServerConfig: ServerConfig = {
      configDir: root,
      stateDir,
      host: "127.0.0.1",
      port: 0,
      listenPort: 0,
      publicBaseUrl: "http://127.0.0.1:19999",
      allowedHosts: ["127.0.0.1", "localhost"],
      oauth: {
        ownerToken,
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 86400,
        refreshTokenGraceSeconds: 300,
        scopes: ["devspace"],
        allowedResourceUrls: [],
        allowedRedirectHosts: ["localhost", "127.0.0.1"],
      },
      agy: {
        bin: "/nonexistent/agy-binary-not-required",
        workspace,
        agyHome,
        modelId: "gemini-3.1-pro-preview",
        wireProtocol: "genai",
        holdMs: 5_500,
        callTimeoutMs: 25_000,
        warnToolCallsPerSession: 0,
        sessionIdleTtlMs: 600_000,
        exposedTools: ["read_file", "write_file", "edit_file", "run_command", "manage_task"],
      },
      skills: {
        enabled: true,
        paths: [customSkillsDir],
      },
      codeMode: {
        enabled: true,
      },
      ui: {
        enabled: true,
      },
      activity: {
        enabled: true,
        maxCalls: 200,
      },
      logging: {
        level: "error",
        format: "json",
        requests: false,
        assets: false,
        toolCalls: false,
        shellCommands: false,
        trustProxy: false,
      },
    };

    // Bind ephemeral port first so publicBaseUrl matches exact MCP resource URL
    const probeListener = (await import("node:http")).createServer();
    await new Promise<void>((r) => probeListener.listen(0, "127.0.0.1", r));
    const port = (probeListener.address() as AddressInfo).port;
    await new Promise<void>((r) => probeListener.close(() => r()));

    baseServerConfig.port = port;
    baseServerConfig.listenPort = port;
    baseServerConfig.publicBaseUrl = `http://127.0.0.1:${port}`;

    // Issue a real OAuth access token in stateDir before starting server
    const mcpUrl = new URL("/mcp", baseServerConfig.publicBaseUrl);
    const seedProvider = new SingleUserOAuthProvider(baseServerConfig.oauth, mcpUrl, stateDir);
    const oauthClient = await seedProvider.clientsStore.registerClient!({
      redirect_uris: ["http://127.0.0.1/callback"],
      client_name: "Gemini Task E2E",
    });
    seedProvider["codes"].set("seed-code", {
      clientId: oauthClient.client_id,
      params: {
        redirectUri: "http://127.0.0.1/callback",
        codeChallenge: "c",
        scopes: ["devspace"],
        resource: mcpUrl,
      },
      expiresAtMs: Date.now() + 60_000,
    });
    const tokens = await seedProvider.exchangeAuthorizationCode(
      oauthClient,
      "seed-code",
      undefined,
      "http://127.0.0.1/callback",
      mcpUrl,
    );
    seedProvider.close();

    const running = await createServer(baseServerConfig);
    const httpServer = running.app.listen(port, "127.0.0.1");
    await new Promise<void>((r) => httpServer.once("listening", r));
    t.after(async () => {
      await new Promise<void>((r) => httpServer.close(() => r()));
      await running.close();
    });

    const authHeaders = { Authorization: `Bearer ${tokens.access_token}` };

    // Connect two independent MCP clients (simulating two Gemini Task Sub Agents)
    const transportA = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: authHeaders },
    });
    const transportB = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: authHeaders },
    });
    const subAgentA = new Client({ name: "gemini-subagent-a", version: "1.0.0" });
    const subAgentB = new Client({ name: "gemini-subagent-b", version: "1.0.0" });

    await Promise.all([subAgentA.connect(transportA), subAgentB.connect(transportB)]);
    t.after(async () => {
      await subAgentA.close();
      await subAgentB.close();
    });

    // 1. Verify each Sub Agent got its own distinct Mcp-Session-Id
    assert.ok(transportA.sessionId, "Sub Agent A received Mcp-Session-Id");
    assert.ok(transportB.sessionId, "Sub Agent B received Mcp-Session-Id");
    assert.notEqual(transportA.sessionId, transportB.sessionId);

    // 2. Verify exposed tools (5 agy + 3 Code Mode + userRules) and cleaned JSON schemas + skills instructions
    assert.match(subAgentA.getInstructions() ?? "", /demo-skill/);
    const { tools } = await subAgentA.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "cancel_execution",
        "edit_file",
        "execute",
        "manage_task",
        "poll_execution",
        "read_file",
        "run_command",
        "userRules",
        "write_file",
      ],
    );
    for (const tool of tools) {
      assert.equal("$schema" in tool.inputSchema, false, `${tool.name} schema clean`);
    }
    const readTool = tools.find((tool) => tool.name === "read_file")!;
    assert.match(readTool.description ?? "", /image/i);

    // 3. Verify write_file -> edit_file -> read_file (text + PNG image)
    const sampleTxt = join(workspace, "hello.txt");
    await subAgentA.callTool({
      name: "write_file",
      arguments: { Path: sampleTxt, Content: "alpha\nbeta\n", Overwrite: true },
    });
    await subAgentA.callTool({
      name: "edit_file",
      arguments: { Path: sampleTxt, Target: "beta", Replacement: "gamma" },
    });
    const readTxtRes = await subAgentA.callTool({
      name: "read_file",
      arguments: { Path: sampleTxt },
    });
    const readTxt = (readTxtRes.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    assert.match(readTxt, /alpha/);
    assert.match(readTxt, /gamma/);

    const samplePng = join(workspace, "pixel.png");
    await writeFile(samplePng, Buffer.from(TINY_PNG_BASE64, "base64"));
    const readPngRes = await subAgentA.callTool({
      name: "read_file",
      arguments: { Path: samplePng },
    });
    const imgBlock = (
      readPngRes.content as Array<{ type: string; mimeType?: string; data?: string }>
    ).find((c) => c.type === "image");
    assert.ok(imgBlock, "read_file on PNG returned an MCP image content block");
    assert.equal(imgBlock.mimeType, "image/png");
    assert.equal(imgBlock.data, TINY_PNG_BASE64);

    // 4. Verify true parallel execution across Sub Agent A and Sub Agent B
    const parallelStart = Date.now();
    const [resA, resB] = await Promise.all([
      subAgentA.callTool({
        name: "run_command",
        arguments: {
          CommandLine: "sleep 1.2 && echo SUB_A_OK",
          WaitMsBeforeAsync: 5000,
          toolSummary: "Parallel A",
        },
      }),
      subAgentB.callTool({
        name: "run_command",
        arguments: {
          CommandLine: "sleep 1.2 && echo SUB_B_OK",
          WaitMsBeforeAsync: 5000,
          toolSummary: "Parallel B",
        },
      }),
    ]);
    const parallelElapsed = Date.now() - parallelStart;
    assert.ok(
      parallelElapsed < 2_300,
      `Expected parallel execution (<2300ms), got ${parallelElapsed}ms`,
    );
    assert.match(
      (resA.content as Array<{ text?: string }>)[0]?.text ?? "",
      /SUB_A_OK/,
    );
    assert.match(
      (resB.content as Array<{ text?: string }>)[0]?.text ?? "",
      /SUB_B_OK/,
    );

    // 5. Verify server-side hold on run_command: WaitMsBeforeAsync=600 backgrounds at 0.6s in agy,
    //    command finishes at 2.0s (<= holdMs 5.5s), and returns synchronously in ONE call!
    const heldCmdRes = await subAgentA.callTool({
      name: "run_command",
      arguments: {
        CommandLine: "sleep 2.0 && echo HELD_ONE_SHOT_DONE",
        WaitMsBeforeAsync: 600,
        toolSummary: "Held sync command",
      },
    });
    const heldText = (heldCmdRes.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.match(heldText, /HELD_ONE_SHOT_DONE/);

    // 6. Verify command exceeding holdMs (sleep 7.5s > holdMs 5.5s) returns TaskId,
    //    Sub Agent B does NOT see Sub Agent A's task, and manage_task(status) holds until completion
    //    AND preserves the real exit code (42) from <SYSTEM_MESSAGE>!
    const longCmdRes = await subAgentA.callTool({
      name: "run_command",
      arguments: {
        CommandLine: "sleep 7.5 && echo LONG_ASYNC_DONE && exit 42",
        WaitMsBeforeAsync: 600,
        toolSummary: "Long async command",
      },
    });
    const longText = (longCmdRes.content as Array<{ text?: string }>)[0]?.text ?? "";
    const taskIdMatch = longText.match(/task id: (\S+)/i);
    assert.ok(taskIdMatch, `Expected background task id in: ${longText}`);
    const taskId = taskIdMatch[1]!;

    // Sub Agent B's task list must NOT contain Sub Agent A's running task
    const listBRes = await subAgentB.callTool({
      name: "manage_task",
      arguments: { Action: "list" },
    });
    const listBText = (listBRes.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.equal(listBText.includes(taskId), false, "Sub Agent B must not see Sub Agent A's task");

    // Sub Agent A calls manage_task(status) which holds until the 7.5s command completes
    const statusRes = await subAgentA.callTool({
      name: "manage_task",
      arguments: { Action: "status", TaskId: taskId },
    });
    const statusText = (statusRes.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.match(statusText, /LONG_ASYNC_DONE/);
    assert.match(statusText, /code 42/);

    // 7. Verify Code Mode (execute batching multiple agy calls + poll_execution)
    const batchFile = join(workspace, "codemode.txt");
    const execRes = await subAgentA.callTool({
      name: "execute",
      arguments: {
        code: `
          await tools.write_file({ Path: ${JSON.stringify(batchFile)}, Content: "line1\\nline2\\n", Overwrite: true });
          const r = await tools.read_file({ Path: ${JSON.stringify(batchFile)} });
          console.log("batch ok");
          return { containsLine2: r.text.includes("line2") };
        `,
      },
    });
    const execSnap = JSON.parse((execRes.content as Array<{ text?: string }>)[0]?.text ?? "{}") as {
      status: string;
      result?: { containsLine2?: boolean };
      calls?: Array<{ tool: string }>;
      logs?: string[];
    };
    assert.equal(execSnap.status, "completed");
    assert.equal(execSnap.result?.containsLine2, true);
    assert.equal(execSnap.calls?.length, 2);

    const asyncExecRes = await subAgentA.callTool({
      name: "execute",
      arguments: {
        code: `await sleep(1200); return "polled-ok";`,
        yield_time_ms: 500,
      },
    });
    const asyncSnap = JSON.parse((asyncExecRes.content as Array<{ text?: string }>)[0]?.text ?? "{}") as {
      execution_id: string;
      status: string;
    };
    assert.equal(asyncSnap.status, "running");
    const polledRes = await subAgentA.callTool({
      name: "poll_execution",
      arguments: { execution_id: asyncSnap.execution_id, yield_time_ms: 3000 },
    });
    const polledSnap = JSON.parse((polledRes.content as Array<{ text?: string }>)[0]?.text ?? "{}") as {
      status: string;
      result?: string;
    };
    assert.equal(polledSnap.status, "completed");
    assert.equal(polledSnap.result, "polled-ok");

    // 8. Verify /web Activity UI auth + recorded session calls
    const unauthWeb = await fetch(`${baseServerConfig.publicBaseUrl}/web/api/calls`);
    assert.equal(unauthWeb.status, 401);

    const loginRes = await fetch(`${baseServerConfig.publicBaseUrl}/web/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ owner_token: ownerToken }),
      redirect: "manual",
    });
    assert.equal(loginRes.status, 303);
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.match(cookie, /^devspace_web_session=/);

    const authWeb = await fetch(`${baseServerConfig.publicBaseUrl}/web/api/calls`, {
      headers: { cookie },
    });
    assert.equal(authWeb.status, 200);
    const webData = (await authWeb.json()) as {
      sessions: Array<{ mcpSessionId: string }>;
      calls: Array<{ tool: string }>;
    };
    assert.ok(webData.sessions.length >= 2);
    assert.ok(webData.calls.some((c) => c.tool === "execute"));

    // 9. Verify stale/restarted Mcp-Session-Id header never returns 400 or 404
    const staleResp = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        ...authHeaders,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "restarted-stale-session-id-9999",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(staleResp.status, 200);
  },
);

test("deterministic agy 1.5.10 parity contracts: validation, read_file pagination, write/edit semantics, PTY & process-group kill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-agy-contracts-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = join(root, "ws");
  const agyHome = join(root, "state");

  const bridge = new AgyBridge(
    {
      bin: "/nonexistent/agy",
      workspace,
      agyHome,
      modelId: "unused",
      wireProtocol: "genai",
      holdMs: 2_500,
      callTimeoutMs: 10_000,
      warnToolCallsPerSession: 0,
      sessionIdleTtlMs: 600_000,
      exposedTools: ["read_file", "write_file", "edit_file", "run_command", "manage_task"],
    },
    {
      level: "error",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  );
  await bridge.start();
  t.after(() => bridge.close());

  // 1. Cleaned schema normalizes string minLength: "1" -> number 1
  const tools = await bridge.listTools();
  const writeSchema = tools.find((tl) => tl.name === "write_file")!.inputSchema;
  const writeProps = writeSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(writeProps.Path?.minLength, 1);

  // 2. Strict validation errors match agy 1.5.10 format
  const valErr = await bridge.callTool("s1", "write_file", { Path: "", Extra: 1 } as Record<string, unknown>);
  assert.equal(valErr.isError, true);
  const valTxt = (valErr.content[0] as { text: string }).text;
  assert.match(valTxt, /^Encountered error in tool validation: invalid arguments:/);
  assert.match(valTxt, /missing property 'Content'/);
  assert.match(valTxt, /additional properties 'Extra' not allowed/);
  assert.match(valTxt, /at '\/Path': minLength: got 0, want 1/);

  // 3. write_file: create, conflict without Overwrite, Append auto-newline, and mode preservation
  const f1 = join(workspace, "sub/dir/notes.sh");
  const w1 = await bridge.callTool("s1", "write_file", { Path: f1, Content: "first" });
  assert.equal(w1.isError, undefined);
  assert.match((w1.content[0] as { text: string }).text, /Created file\.$/);
  await chmod(f1, 0o755);

  const wConflict = await bridge.callTool("s1", "write_file", { Path: f1, Content: "nope" });
  assert.equal(wConflict.isError, true);
  assert.match((wConflict.content[0] as { text: string }).text, /already exists\. To overwrite it, retry with Overwrite=true/);

  const wBoth = await bridge.callTool("s1", "write_file", {
    Path: f1,
    Content: "x",
    Overwrite: true,
    Append: true,
  });
  assert.equal(wBoth.isError, true);
  assert.match((wBoth.content[0] as { text: string }).text, /Overwrite and Append cannot both be true/);

  const wAppend = await bridge.callTool("s1", "write_file", { Path: f1, Content: "second", Append: true });
  assert.equal(wAppend.isError, undefined);
  assert.equal(await readFile(f1, "utf8"), "first\nsecond");
  assert.equal((await stat(f1)).mode & 0o777, 0o755);

  // 4. edit_file: multi-occurrence non-overlapping, CRLF normalization, regex metachar safety, LCS +A/-R
  const crlfPath = join(workspace, "crlf.txt");
  await writeFile(crlfPath, "line1\r\nfoo\r\nfoo\r\nend\r\n");
  const edRes = await bridge.callTool("s1", "edit_file", {
    Path: crlfPath,
    Target: "foo",
    Replacement: "BAR_$&_1\nBAR_2",
  });
  assert.equal(edRes.isError, undefined);
  assert.match(
    (edRes.content[0] as { text: string }).text,
    /Made 2 replacements in .*crlf\.txt starting at line 2 \(\+4\/-2 lines\)\./,
  );
  assert.equal(await readFile(crlfPath, "utf8"), "line1\r\nBAR_$&_1\r\nBAR_2\r\nBAR_$&_1\r\nBAR_2\r\nend\r\n");

  // 5. read_file: empty file, no-trailing-newline marker, 800-line cap, 46080-byte rendered window + ByteOffset continuation, binary rejection
  const emptyPath = join(workspace, "empty.txt");
  await writeFile(emptyPath, "");
  const rEmpty = await bridge.callTool("s1", "read_file", { Path: emptyPath });
  assert.match((rEmpty.content[0] as { text: string }).text, /File is empty$/);

  const rNoNl = await bridge.callTool("s1", "read_file", { Path: f1 });
  assert.match((rNoNl.content[0] as { text: string }).text, /\(no newline at end of file\)$/);

  const thousandLines = join(workspace, "1000.txt");
  await writeFile(
    thousandLines,
    Array.from({ length: 1000 }, (_, i) => `row-${i + 1}`).join("\n") + "\n",
  );
  const rCap = await bridge.callTool("s1", "read_file", { Path: thousandLines });
  assert.match((rCap.content[0] as { text: string }).text, /Showing lines 1-800 of 1000\n1: row-1/);

  const widePath = join(workspace, "wide.txt");
  await writeFile(
    widePath,
    Array.from({ length: 100 }, (_, i) => `L${i + 1}:${"X".repeat(600)}`).join("\n") + "\n",
  );
  const rPart1 = await bridge.callTool("s1", "read_file", { Path: widePath, StartLine: 1, EndLine: 100 });
  const part1Text = (rPart1.content[0] as { text: string }).text;
  const nextOffMatch = part1Text.match(/ByteOffset=(\d+)/);
  assert.ok(nextOffMatch, "Expected ByteOffset continuation hint");
  const nextOff = Number(nextOffMatch[1]);
  const rPart2 = await bridge.callTool("s1", "read_file", {
    Path: widePath,
    StartLine: 1,
    EndLine: 100,
    ByteOffset: nextOff,
  });
  const part2Text = (rPart2.content[0] as { text: string }).text;
  assert.match(part2Text, new RegExp(`Showing bytes ${nextOff}-\\d+ of \\d+ in this line range\\.`));

  const binPath = join(workspace, "raw.bin");
  await writeFile(binPath, Buffer.from([0x00, 0xff, 0xfe, 0x01]));
  const rBin = await bridge.callTool("s1", "read_file", { Path: binPath });
  assert.equal(rBin.isError, true);
  assert.match((rBin.content[0] as { text: string }).text, /binary file detected/);

  // 6. run_command: true PTY (isatty + CRLF), real user HOME inheritance, and 10,240-byte middle truncation
  const ptyCheck = await bridge.callTool("s1", "run_command", {
    CommandLine: '[ -t 0 ] && [ -t 1 ] && [ -t 2 ] && echo "PTY_OK HOME=$HOME"',
    WaitMsBeforeAsync: 5000,
    toolSummary: "Verify PTY and HOME",
  });
  const ptyTxt = (ptyCheck.content[0] as { text: string }).text;
  assert.match(ptyTxt, /PTY_OK HOME=/);
  assert.equal(ptyTxt.includes(`HOME=${agyHome}`), false, "Should inherit real user HOME rather than isolated agyHome");
  assert.ok(ptyTxt.includes("\r\n"), "PTY output should preserve CRLF line endings");

  const bigRes = await bridge.callTool("s1", "run_command", {
    CommandLine: "python3 -c 'print(\"Z\" * 15000)'",
    WaitMsBeforeAsync: 5000,
    toolSummary: "Big output",
  });
  const bigTxt = (bigRes.content[0] as { text: string }).text;
  assert.match(bigTxt, /<truncated \d+ of \d+ bytes from the middle of the output>/);
  const fileUrlMatch = bigTxt.match(/file:\/\/([^\s]+output\.txt)\./);
  assert.ok(fileUrlMatch);
  const savedFull = await readFile(new URL(`file://${fileUrlMatch[1]}`), "utf8");
  assert.ok(savedFull.length > 15_000);

  // 7. manage_task: interactive send_input + hard process-group kill + cross-session isolation
  const bgInteractive = await bridge.callTool("s1", "run_command", {
    CommandLine: "python3 -u -c 'import sys; line = sys.stdin.readline().strip(); print(\"ECHO:\" + line)'",
    WaitMsBeforeAsync: 500,
    IsDaemon: true,
    toolSummary: "Interactive reader",
  });
  const interactiveId = (bgInteractive.content[0] as { text: string }).text.match(/task id: (\S+)/)![1]!;

  // Cross-session isolation check
  const wrongSessionRes = await bridge.callTool("s2", "manage_task", {
    Action: "status",
    TaskId: interactiveId,
  });
  assert.equal(wrongSessionRes.isError, true);
  assert.match((wrongSessionRes.content[0] as { text: string }).text, /belongs to a different conversation/);

  const sendRes = await bridge.callTool("s1", "manage_task", {
    Action: "send_input",
    TaskId: interactiveId,
    Input: "hello_pty\n",
  });
  assert.match((sendRes.content[0] as { text: string }).text, /Input sent to task/);

  const interactiveDone = await bridge.callTool("s1", "manage_task", {
    Action: "status",
    TaskId: interactiveId,
  });
  assert.match((interactiveDone.content[0] as { text: string }).text, /ECHO:hello_pty/);

  // Process-group kill check (no orphan child processes)
  const pidFile = join(workspace, "child.pid");
  const bgTree = await bridge.callTool("s1", "run_command", {
    CommandLine: `python3 -c 'import os, subprocess, time; p = subprocess.Popen(["sleep", "60"]); open(${JSON.stringify(pidFile)}, "w").write(str(p.pid)); time.sleep(60)'`,
    WaitMsBeforeAsync: 600,
    IsDaemon: true,
    toolSummary: "Spawn child sleeper",
  });
  const treeTaskId = (bgTree.content[0] as { text: string }).text.match(/task id: (\S+)/)![1]!;
  const childPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(childPid > 1);

  const killRes = await bridge.callTool("s1", "manage_task", {
    Action: "kill",
    TaskId: treeTaskId,
  });
  assert.match((killRes.content[0] as { text: string }).text, /cancelled\.$/);

  let childAlive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    childAlive = false;
  }
  assert.equal(childAlive, false, "Descendant sleep process must be killed with the task");

  const killAgain = await bridge.callTool("s1", "manage_task", {
    Action: "kill",
    TaskId: treeTaskId,
  });
  assert.equal(killAgain.isError, true);
  assert.match((killAgain.content[0] as { text: string }).text, /task is not running \(status: CANCELED\)/);
});

test("warnToolCallsPerSession 只软提醒不拦截: 长会话可以一直跑下去", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-turn-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "ws");
  await mkdir(workspace, { recursive: true });
  const workspaceFile = join(workspace, "note.txt");
  await writeFile(workspaceFile, "hello\n");

  const bridge = new AgyBridge(
    {
      bin: "/nonexistent/agy",
      workspace,
      agyHome: join(root, "state"),
      modelId: "unused",
      wireProtocol: "genai",
      holdMs: 1_000,
      callTimeoutMs: 10_000,
      warnToolCallsPerSession: 3,
      sessionIdleTtlMs: 600_000,
      exposedTools: ["read_file", "write_file", "edit_file", "run_command", "manage_task"],
    },
    {
      level: "error",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  );
  await bridge.start();
  t.after(() => bridge.close());

  // 7 次调用跨过两个提醒档位 (3, 6); 计数在本次调用前结算, 故提醒落在第 4 / 7 次
  const texts: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const res = await bridge.callTool("warn-session", "read_file", { Path: workspaceFile });
    assert.notEqual(res.isError, true, `第 ${i + 1} 次调用不该被硬拦`);
    texts.push((res.content[0] as { text: string }).text);
  }

  assert.equal(texts.filter((txt) => txt.includes("次工具调用")).length, 2, "每个档位只提醒一次");
  assert.match(texts[3]!, /此前已累计 3 次工具调用/);
  assert.match(texts[6]!, /此前已累计 6 次工具调用/);
});
