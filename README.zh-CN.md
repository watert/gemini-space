# Gemini Space

**[English](./README.md) · [简体中文](./README.zh-CN.md)**

[![CI](https://github.com/cunninghamcard-bit/gemini-space/actions/workflows/ci.yml/badge.svg)](https://github.com/cunninghamcard-bit/gemini-space/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js >= 22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](https://nodejs.org)

**把你的本地电脑交给网页版 Google Gemini（以及 Gemini Task 多并发子代理）——原生提供 Gemini 训练时最熟悉的 Antigravity (`agy`) 工具集。**

---

## 为什么要做 Gemini Space？

市面上现有的本地编码 MCP 服务（如 `Desktop Commander`、`DevSpace`、`Filesystem MCP`）大多是按 ChatGPT / Codex（`exec_command`、`write_stdin`、`apply_patch`、`open_workspace`）或 Claude Code 的工具形态设计的。当你把它们挂进**网页版 Gemini（`gemini.google.com` → Custom Connectors）**时，会撞上两堵墙：

1. **工具分布水土不服**：Gemini 系列模型在后训练阶段深度对齐的是 Google Antigravity（`agy`）那套 PascalCase 工具集（`read_file`、`write_file`、`edit_file`、`run_command`、`manage_task`），直接用绝对路径读写，不需要每开一个对话先浪费一轮 `open_workspace` 拿 `workspace_id`。
2. **Gemini 网页端 Connector 的隐藏协议限制（实测踩坑总结）**：
   - **JSON Schema 校验极严**：只要 `inputSchema` 里带 `$schema`、`additionalProperties`、`$defs`、`const` 或超过 32 位整数的 `maximum`，添加 Connector 时就会直接报错连接失败。
   - **单次调用约 60 秒硬超时 & 不支持 MCP `Tasks`**：Gemini 网页端虽然握手声明 `2025-11-25` 协议，但实际不带 `tasks` 能力，一轮结束后也不会因服务端推送通知自动唤醒；任何单次调用超过 ~60 秒就会报 `MCP request timed out (DEADLINE_EXCEEDED)`。
   - **Gemini Task 多子代理并发竞争**：在网页版 **Gemini Task** 模式下，云端会同时派出多个 Subagent 并发连接 `/mcp`（云端原生 Subagent 本身没有本地文件权限，全靠调这个 MCP 干活）。如果没有按会话隔离任务队列、没有做 Refresh Token 并发轮换防抖，多个子代理就会出现排队超 60s、后台任务通知串台，甚至并发刷新令牌触发 `401` 掉线。

**Gemini Space** 针对上面每一个边界从头打磨：在纯 Node.js 中确定性复刻了整套 `agy` 工具语义，**不依赖闭源 `agy` 二进制，无需登录额外账号，生产依赖仅 6 个轻量 npm 包 + Node 内置 `node:sqlite`**。

---

## 核心特性

- **5 个纯 Node.js 原生确定性 `agy` 工具**
  - `read_file`：单次最多 800 行 / 46,080 字节，支持 UTF-8 字符边界安全的 `ByteOffset` 续读；基于文件头魔数支持多模态内联返回（`PNG`、`JPEG`、`GIF`、`WebP`、`PDF`、`MP3`、`WAV`、`MP4`）。
  - `write_file`：自动创建父目录，支持 `Overwrite` 与智能补换行的 `Append`，原地保留文件可执行权限位。
  - `edit_file`：自动兼容 `LF` / `CRLF` / 混合换行匹配与全量替换，返回精确的行级 LCS `(+A/-R lines)` 统计，内置同路径写锁防止多子代理并发写坏同一文件。
  - `run_command`：真实 `80×24` PTY 终端执行（`zsh -c`），完整继承本机真实 `HOME`（`~/.ssh`、`~/.gitconfig` 全可用），自动剥离 ANSI 控制序列，超 10 KiB 头尾截断并将完整输出落盘备查。
  - `manage_task`：支持 `list`、`status`、`send_input`（交互式向 PTY 写入输入）以及无孤儿残留的进程组+子孙树递归 `SIGKILL`（`kill`）。
- **45 秒服务端智能等待（无缝跨越网页端 60s 超时红线）**
  - 非守护命令在服务端自动同步等待最多 **45 秒**：45 秒内跑完的测试/构建**一次调用直接返回完整输出与退出码**；
  - 超过 45 秒的长耗时命令返回后台 `TaskId`，后续每次调用 `manage_task(Action: "status")` 服务端同样最多 hold **45 秒**接力等待，直至拿到最终退出码和输出。
- **专为 Gemini Task 多 Subagent 并发设计**
  - `initialize` 握手签发软会话头 `Mcp-Session-Id`（**1 个 Gemini Subagent ↔ 1 个独立后台任务与通知队列**），跨子代理真并行执行互不阻塞；且本地服务重启后收到旧会话头会自动平滑接管，绝不报 `404 Session not found`。
- **Code Mode 批处理引擎（`execute` / `poll_execution` / `cancel_execution`）**
  - 允许 Gemini 在单次工具调用里提交一段异步 JS 脚本，在本地循环或并发调用 `tools.read_file`、`tools.edit_file`、`tools.run_command` 再汇总返回——把 20 次工具往返压缩成 **1 次**，彻底绕开网页端单轮工具调用次数上限。
- **会话调用量只提醒，不硬拦**
  - 累计工具调用数每达到 `warnToolCallsPerSession`（默认 200，设 `0` 关闭）的整数倍，会在工具结果尾部追加一次「可开新对话」的提醒；长会话继续跑得下去。资源边界交给并发会话数、任务/通知上限与单次调用超时来守，不再用轮次计数误伤长任务。
- **本机 Skills 自动扫描注入**
  - 启动时自动扫描 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.devspace/skills` 下的 `SKILL.md`，拼入 MCP `instructions`（Google 文档确认会直接注入 Gemini 的 System Prompt），模型按需直接 `read_file` 读取。
- **自托管 OAuth 2.1 + `/web/` 审计面板**
  - 主人密码（Owner Password）单用户授权页、SQLite 哈希令牌持久化、**300 秒 Refresh Token 轮换宽限期**（彻底杜绝多子代理并发刷新 401）、内置 Gemini Schema 清洗器（无需外挂代理），以及零前端构建的 `/web/` 实时会话调用审计面板。

---

## 5 分钟上手指南

### 1. 环境准备
- **Node.js `>= 22.19`**（使用内置 `node:sqlite`）及 `pnpm`
- macOS 或 Linux
- 一条把本机 `7676` 端口暴露为公网 HTTPS 的隧道（推荐 **Tailscale Funnel** 或 **Cloudflare Tunnel**）

### 2. 克隆与构建

```bash
git clone https://github.com/cunninghamcard-bit/gemini-space.git
cd gemini-space
pnpm install
pnpm build
```

### 3. 初始化配置并暴露隧道

```bash
# 以 Tailscale Funnel 为例，把本机 7676 端口暴露为 HTTPS：
tailscale funnel --bg 7676

# 生成 ~/.devspace/config.jsonc 并在 ~/.devspace/auth.json 中生成主人密码：
./bin/gemini-space.js init --public-url https://你的机器名.你的tailnet.ts.net

# 自检配置、数据库、Skills 与工具列表：
./bin/gemini-space.js doctor

# 启动服务：
./bin/gemini-space.js serve
```

> **提示：** 自动生成的主人密码保存在 `~/.devspace/auth.json` 的 `ownerToken` 字段中，连接 Gemini 和登录 `https://<你的域名>/web/` 时输入它即可。

### 4. 在网页版 Gemini 中添加 Connector

1. 打开 **[gemini.google.com/customize/connectors](https://gemini.google.com/customize/connectors)** → 点击 **+ Custom**。
2. MCP Server URL 填入：
   ```text
   https://你的机器名.你的tailnet.ts.net/mcp
   ```
   *（Client ID 和 Secret 留空即可，服务支持 OAuth 动态客户端注册。）*
3. 跳转到授权页后输入 `~/.devspace/auth.json` 里的 **Owner Password** 点击批准。
4. 打开 Gemini 普通对话或 **Gemini Task**，即可直接读写本地代码库、跑测试和构建！

> ⚠️ **避坑提醒（实测血泪教训）：** Google 会按**主机名（Hostname）**合并自定义 Connector 的 OAuth 账号关联。千万**不要**在同一个域名（哪怕换端口如 `:8443`）下往 Gemini 添加第二个测试 Connector，否则会冲掉主服务的令牌导致 401。如需并行测试其他 MCP 服务，请务必使用不同域名（例如 `cloudflared tunnel` 的 `*.trycloudflare.com`）。

---

## 与 T3 Code 搭配使用（多模型异构协作）

如果你想让网页版 Gemini 在遇到大型架构改动或跨模型交叉 Review 时，顺手调度本机的 **Claude Code / Codex / Grok / DeepSeek** 线程并在桌面 GUI 中实时查看：
- 直接开启 [T3 Code](https://github.com/pingdotgg/t3code) 官方原生的 `t3 up --connect`，把 `<你的环境>.t3.codes/mcp` 作为第二个独立 Connector 挂进 Gemini 即可（`t3.codes` 独立域名与本服务完全解耦，零冲突）。

---

## 常用命令

```bash
gemini-space serve                        # 启动 OAuth + MCP + /web/ 服务
gemini-space doctor                       # 检查配置、OAuth 数据库、已发现的本机 Skills 与工具
gemini-space init --public-url <https>    # 初始化配置文件与主人密码
gemini-space config show                  # 查看当前生效配置
gemini-space config set codeMode.enabled false
```

---

## 致谢与许可证

本项目早期基于 [@waishnav/devspace](https://github.com/Waishnav/devspace) 的 OAuth 2.1 SQLite 底座精简重构（移除了约 7.9 万行面向旧工具面的代码），并重写了纯 Node.js 的确定性 Antigravity 工具引擎与多子代理并发会话模型。

基于 [MIT License](./LICENSE) 开源。
