# Gemini Space

**[English](./README.md) · [简体中文](./README.zh-CN.md)**

[![CI](https://github.com/cunninghamcard-bit/gemini-space/actions/workflows/ci.yml/badge.svg)](https://github.com/cunninghamcard-bit/gemini-space/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](https://nodejs.org)

**Give Google Gemini Web (and its parallel Task subagents) your local machine—speaking the exact Antigravity (`agy`) tool surface Gemini was trained on.**

---

## Why Gemini Space?

Most local coding MCP servers (`Desktop Commander`, `DevSpace`, `Filesystem MCP`) were designed around ChatGPT / Codex (`exec_command`, `write_stdin`, `apply_patch`, `open_workspace`) or Claude Code. When you connect them to **Gemini Web (`gemini.google.com` → Custom Connectors)**, you hit two walls:

1. **Wrong tool distribution**: Gemini models are post-trained heavily on Google Antigravity's PascalCase tool surface (`read_file`, `write_file`, `edit_file`, `run_command`, `manage_task`) with absolute paths and zero `open_workspace` ceremony.
2. **Gemini Web Connector protocol quirks**:
   - **Strict JSON Schema subset**: Connector registration fails (`"We had trouble connecting"`) if `inputSchema` contains `$schema`, `additionalProperties`, `$defs`, `const`, or >32-bit integer bounds.
   - **~60s hard RPC timeout & no MCP `Tasks`**: Gemini Web declares MCP `2025-11-25` without `tasks` capability, ignores post-turn server push notifications, and kills any tool call exceeding ~60s (`DEADLINE_EXCEEDED`).
   - **Parallel Task Subagents**: In **Gemini Task** mode, Gemini spawns multiple cloud subagents that simultaneously `initialize` against your `/mcp` endpoint. Without session isolation and concurrent refresh-token rotation grace, subagents either block each other past 60s, leak background task notices across agents, or trigger `401` token-rotation races.

**Gemini Space** is a lightweight, self-hosted MCP server built from the ground up around those exact constraints—with **zero closed-source binary dependencies** (only 6 runtime npm packages + Node's built-in `node:sqlite`).

---

## Key Features

- **5 Native Deterministic `agy` Tools (Pure Node.js)**
  - `read_file`: 800-line / 46,080-byte paginated text reads with UTF-8 safe `ByteOffset` continuation + magic-byte multimodal inline blocks (`PNG`, `JPEG`, `GIF`, `WebP`, `PDF`, `MP3`, `WAV`, `MP4`).
  - `write_file`: Automatic parent directory creation, `Overwrite`, and newline-aware `Append` while preserving file mode bits.
  - `edit_file`: EOL-normalized (`LF` / `CRLF` / mixed) exact replacement across occurrences with LCS `(+A/-R lines)` diff summaries and per-file write locks.
  - `run_command`: Real `80×24` PTY execution (`zsh -c`), inheriting your real `HOME` (`~/.ssh`, `~/.gitconfig`), ANSI stripping, and 10 KiB head/tail truncation with full output saved on disk.
  - `manage_task`: `list`, `status`, `send_input` (interactive PTY stdin), and orphan-free process-group + descendant `SIGKILL` (`kill`).
- **45-Second Smart Hold (Bridging Gemini's 60s Ceiling)**
  - Non-daemon `run_command` calls automatically hold on the server for up to **45s**—commands under 45s finish in **one round trip**.
  - Commands exceeding 45s return a `TaskId`; each `manage_task(Action: "status")` call holds up to another **45s** until completion, preserving the real exit code and output.
- **Built for Gemini Task Multi-Subagent Concurrency**
  - Issues soft `Mcp-Session-Id` headers on `initialize` (`1 Gemini Subagent ↔ 1 isolated task/notice queue`), executes commands across subagents truly in parallel, and never `404`s stale sessions across local server restarts.
- **Code Mode (`execute` / `poll_execution` / `cancel_execution`)**
  - Run an async JavaScript snippet on your machine calling `tools.read_file`, `tools.edit_file`, `tools.run_command` in loops or `Promise.all`—collapsing 20+ operations into a **single Gemini tool call**.
- **Session Call Budget Warns, Never Blocks**
  - Every `warnToolCallsPerSession` calls (default 200, `0` disables) the tool result gets one extra line suggesting a fresh conversation. Long sessions keep running—resource bounds are the concurrent-session cap, task/notice caps, and per-call timeouts, not a turn counter.
- **Automatic Local Skills Injection**
  - Scans `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and `~/.devspace/skills` (`SKILL.md`) into MCP `instructions` (injected directly into Gemini Web's system prompt).
- **OAuth 2.1 + `/web/` Activity Dashboard**
  - Single-owner password approval page, SHA-256 hashed SQLite token store with a **300-second refresh-token rotation grace window**, built-in Gemini Schema sanitizer, and a zero-build `/web/` UI to inspect every subagent session and tool call.

---

## Architecture

```mermaid
flowchart LR
  subgraph Gemini Web / Gemini Task
    SA1["Main Agent / Subagent A\n(Mcp-Session-Id: S1)"]
    SA2["Subagent B\n(Mcp-Session-Id: S2)"]
  end

  Tunnel["HTTPS Tunnel\n(Tailscale Funnel / Cloudflare)"]

  subgraph Gemini Space (Local Mac / Linux)
    Auth["OAuth 2.1 + 300s Refresh Grace\n+ Gemini Schema Sanitizer"]
    Router["Soft Session Router\n(S1 / S2 Isolated Queues)"]
    Engine["Deterministic AGY Engine\n(80x24 PTY · 45s Hold · Multimodal FS)"]
    CM["Code Mode VM\n(execute / poll / cancel)"]
    Web["/web/ Activity UI"]
  end

  SA1 & SA2 -- "HTTPS POST /mcp" --> Tunnel --> Auth --> Router
  Router --> Engine & CM
  Router -. "SQLite audit" .-> Web
```

---

## 5-Minute Quickstart

### 1. Prerequisites
- **Node.js `>= 22.19`** (uses built-in `node:sqlite`) and `pnpm`
- macOS or Linux
- An HTTPS tunnel pointing to your local port `7676` (e.g., **Tailscale Funnel** or **Cloudflare Tunnel**)

### 2. Clone & Build

```bash
git clone https://github.com/cunninghamcard-bit/gemini-space.git
cd gemini-space
pnpm install
pnpm build
```

### 3. Initialize & Start Tunnel

```bash
# Expose local port 7676 over HTTPS (example using Tailscale Funnel):
tailscale funnel --bg 7676

# Initialize ~/.devspace/config.jsonc and generate your Owner Password in ~/.devspace/auth.json:
./bin/gemini-space.js init --public-url https://your-machine.your-tailnet.ts.net

# Verify everything is ready:
./bin/gemini-space.js doctor

# Start the server:
./bin/gemini-space.js serve
```

> **Tip:** Your generated Owner Password is saved in `~/.devspace/auth.json` (`ownerToken`). You will enter it once when authorizing Gemini Web or signing into `https://<your-host>/web/`.

### 4. Connect to Google Gemini Web

1. Open **[gemini.google.com/customize/connectors](https://gemini.google.com/customize/connectors)** → click **+ Custom**.
2. Enter your MCP Server URL:
   ```text
   https://your-machine.your-tailnet.ts.net/mcp
   ```
   *(Leave Client ID / Secret blank — Gemini Space supports dynamic OAuth client registration.)*
3. Approve the connection using your **Owner Password** from `~/.devspace/auth.json`.
4. Open a chat (or **Gemini Task**) and start coding directly against your local repositories!

> ⚠️ **Important Google Connector Caveat:** Google binds custom connectors by **hostname** (`*.your-tailnet.ts.net`). Do **not** register a second test connector on the same hostname (even on a different port like `:8443`), or Google will overwrite/revoke the shared OAuth account link. Always use a separate hostname (e.g., `*.trycloudflare.com`) if testing another MCP server alongside production.

---

## Running as a Background Service (`launchd` on macOS)

Create `~/Library/LaunchAgents/dev.gemini-space.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.gemini-space.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--import</string>
    <string>/ABSOLUTE/PATH/TO/gemini-space/bin/silence-sqlite-warning.js</string>
    <string>/ABSOLUTE/PATH/TO/gemini-space/dist/cli.js</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>/ABSOLUTE/PATH/TO/gemini-space</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>/Users/YOUR_USERNAME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/YOUR_USERNAME/.devspace/logs/gemini-space.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOUR_USERNAME/.devspace/logs/gemini-space.err.log</string>
</dict>
</plist>
```

Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.gemini-space.server.plist
```

---

## Configuration (`~/.devspace/config.jsonc`)

```jsonc
{
  "configVersion": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    "publicBaseUrl": "https://your-machine.your-tailnet.ts.net"
  },
  "agy": {
    "workspace": "~",
    "holdMs": 45000,
    "exposedTools": ["read_file", "write_file", "edit_file", "run_command", "manage_task"]
  },
  "codeMode": {
    "enabled": true
  },
  "skills": {
    "enabled": true,
    "paths": []
  },
  "ui": {
    "enabled": true
  },
  "activity": {
    "enabled": true,
    "maxCalls": 500
  },
  "oauth": {
    "refreshTokenGraceSeconds": 300
  }
}
```

---

## CLI Reference

```bash
gemini-space serve                        # Start OAuth + MCP + /web/ server
gemini-space doctor                       # Verify config, OAuth DB, discovered skills & tools
gemini-space init --public-url <https>    # Initialize config.jsonc and Owner Password
gemini-space config show                  # Print resolved configuration
gemini-space config set codeMode.enabled false
```

### Calling tools straight from a shell

`gemini-space-call` spawns the stdio server, runs one MCP tool, prints the result,
and exits. No Gemini app, no HTTP, no browser — useful for verifying behaviour or
scripting on top of the same tool surface the model sees.

```bash
gemini-space-call tools                                  # list exposed tools
gemini-space-call read_file '{"Path":"/etc/hosts","StartLine":1,"EndLine":5}'
gemini-space-call run_command '{"CommandLine":"ls ~/docs | head","toolSummary":"list docs","WaitMsBeforeAsync":5000}'
gemini-space-call user_rules '{"Path":"~/docs","Query":"naming"}'
echo '{"CommandLine":"echo hi","toolSummary":"echo","WaitMsBeforeAsync":5000}' | gemini-space-call run_command -
```

Options: `--json` (raw MCP result), `--timeout <ms>`, `--workspace <dir>`, and
`--detach` — the last one kills the server right after the call so a daemon task
survives, letting a second `gemini-space-call manage_task '{"Action":"list"}'`
observe it across processes.

Exit code is `1` when the tool returns `isError`, so it composes in scripts.

---

## Acknowledgements & License

Originally forked from [@waishnav/devspace](https://github.com/Waishnav/devspace) for its clean OAuth 2.1 SQLite foundation, then stripped of ~79k lines of legacy surfaces and rebuilt around a pure Node.js deterministic Antigravity tool engine tailored for Google Gemini Web.

Licensed under the [MIT License](./LICENSE).
