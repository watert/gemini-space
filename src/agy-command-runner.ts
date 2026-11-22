import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AgyToolExecutionError,
  formatAgyTimestamp,
  formatAgyUtcTimestamp,
} from "./agy-tool-schemas.js";

const MAX_TOOL_OUTPUT_BYTES = 10_240;
const TAIL_PREVIEW_BYTES = 1_000;
// 内存捕获上限：头 32KiB 固定，尾部滚动到 512KiB；模型只看这段，磁盘另算。
const MAX_CAPTURED_BYTES = 512 * 1024;
const CAPTURE_HEAD_BYTES = 32 * 1024;
// 磁盘全量输出硬上限，超过即停止追加（64MiB）。
const MAX_OUTPUT_FILE_BYTES = 64 * 1024 * 1024;

// 7-bit ANSI CSI, OSC, and 2-char ESC sequences (preserves \r, \n, \t, \b, \x07)
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const PYTHON_PTY_SHIM = `
import errno, fcntl, os, pty, select, signal, struct, sys, termios

cmd = sys.argv[1]
master_fd, slave_fd = pty.openpty()
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))

pid = os.fork()
if pid == 0:
    os.close(master_fd)
    os.setsid()
    try:
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
    except OSError:
        pass
    os.dup2(slave_fd, 0)
    os.dup2(slave_fd, 1)
    os.dup2(slave_fd, 2)
    if slave_fd > 2:
        os.close(slave_fd)
    shell = "/bin/zsh" if os.path.exists("/bin/zsh") else os.environ.get("SHELL", "/bin/sh")
    os.execv(shell, [os.path.basename(shell), "-c", cmd])

os.close(slave_fd)
try:
    os.write(3, f"PID:{pid}\\n".encode("ascii"))
except OSError:
    pass

stdin_open = True
master_open = True
reaped_status = None

def drain_master_nonblocking():
    os.set_blocking(master_fd, False)
    while True:
        try:
            chunk = os.read(master_fd, 16384)
            if not chunk:
                break
            os.write(1, chunk)
        except OSError:
            break

while master_open:
    if reaped_status is None:
        try:
            wpid, wstatus = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                reaped_status = wstatus
                drain_master_nonblocking()
                break
        except ChildProcessError:
            break
    rlist = [master_fd] + ([0] if stdin_open else [])
    try:
        ready, _, _ = select.select(rlist, [], [], 0.05)
    except InterruptedError:
        continue
    if master_fd in ready:
        try:
            data = os.read(master_fd, 16384)
            if not data:
                master_open = False
            else:
                os.write(1, data)
        except OSError as e:
            if e.errno in (errno.EIO, errno.EBADF):
                master_open = False
            else:
                raise
    if stdin_open and 0 in ready:
        try:
            inp = os.read(0, 16384)
            if not inp:
                stdin_open = False
            else:
                os.write(master_fd, inp)
        except OSError:
            stdin_open = False

try:
    os.close(master_fd)
except OSError:
    pass

if reaped_status is None:
    _, status = os.waitpid(pid, 0)
else:
    status = reaped_status
if os.WIFSIGNALED(status):
    sig = os.WTERMSIG(status)
    try:
        os.write(3, f"SIG:{sig}\\n".encode("ascii"))
    except OSError:
        pass
    os._exit(128 + sig)
os._exit(os.WEXITSTATUS(status))
`.trim();

let cachedPythonBin: string | null | undefined;

function detectPythonPtyBin(): string | null {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  if (process.platform === "win32") {
    cachedPythonBin = null;
    return null;
  }
  for (const candidate of ["/usr/bin/python3", "python3"]) {
    try {
      execFileSync(candidate, ["-c", "import pty"], { stdio: "ignore", timeout: 1_500 });
      cachedPythonBin = candidate;
      return candidate;
    } catch {
      // try next
    }
  }
  cachedPythonBin = null;
  return null;
}

export function stripAnsiAndDecode(raw: Buffer): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  return decoded.replace(ANSI_ESCAPE_RE, "");
}

// 找出最后一个完整 ANSI 序列的结束位置，用于定位末尾可能出现的不完整转义。
function lastCompleteAnsiEnd(text: string): number {
  ANSI_ESCAPE_RE.lastIndex = 0;
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_ESCAPE_RE.exec(text)) !== null) {
    end = match.index + match[0].length;
  }
  ANSI_ESCAPE_RE.lastIndex = 0;
  return end;
}

function encodeFileUri(absPath: string): string {
  return pathToFileURL(absPath).href;
}

function trimHeadUtf8(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

function trimTailUtf8(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
}

/**
 * 按原有 10KiB 中间截断规则生成模型可见文本；output.txt 由流式追加落盘，不再整体重写。
 */
export function truncateAndPersistOutput(fullText: string, outputTxtPath: string): string {
  // 捕获丢弃量由调用方以首行标记传入，不参与 head/tail 截断公式。
  const droppedMatch = /^<dropped (\d+) bytes>\n/.exec(fullText);
  const droppedBytes = droppedMatch ? Number(droppedMatch[1]) : 0;
  const text = droppedMatch ? fullText.slice(droppedMatch[0].length) : fullText;
  const fullBuf = Buffer.from(text, "utf8");
  mkdirSync(join(outputTxtPath, ".."), { recursive: true });
  if (!existsSync(outputTxtPath)) writeFileSync(outputTxtPath, "");

  let fileSize = 0;
  try {
    fileSize = statSync(outputTxtPath).size;
  } catch {
    // 落盘文件不可读时按 0 处理
  }
  // 直接调用（无流式追加）时保留旧落盘行为；流式路径文件非空则不重写。
  if (fileSize === 0 && fullBuf.length > 0) {
    const persisted = fullBuf.subarray(0, MAX_OUTPUT_FILE_BYTES);
    writeFileSync(outputTxtPath, persisted);
    fileSize = persisted.length;
  }
  const logTruncated = fileSize >= MAX_OUTPUT_FILE_BYTES;
  const notes =
    (logTruncated ? `log truncated at ${MAX_OUTPUT_FILE_BYTES} bytes; full output stops there.\n` : "") +
    (droppedBytes > 0 ? `dropped ${droppedBytes} bytes from captured output.\n` : "");

  const totalBytes = fullBuf.length;
  if (totalBytes <= MAX_TOOL_OUTPUT_BYTES) {
    return `${notes}${text}`;
  }

  const fileUri = encodeFileUri(outputTxtPath);
  const prefix =
    `The tool's output was truncated due to being too long. You can find the full output in a file at ${fileUri}.\n\n` +
    "Here is a preview with the middle of the output truncated:\n";
  const prefixBytes = Buffer.byteLength(prefix, "utf8");
  const digitsY = String(totalBytes).length;
  const half = Math.max(64, Math.floor((10_186 - prefixBytes - 2 * digitsY) / 2));

  const head = trimHeadUtf8(fullBuf, half);
  const tail = trimTailUtf8(fullBuf, half);
  const removed = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");

  return `${notes}${prefix}${head}\n<truncated ${removed} of ${totalBytes} bytes from the middle of the output>\n${tail}`;
}

/**
 * Builds the 1,000-byte UTF-8-safe tail preview with `<truncated N lines>` marker.
 */
export function buildTailLogPreview(cleanBytes: Buffer): string {
  if (cleanBytes.length === 0) return "";
  if (cleanBytes.length <= TAIL_PREVIEW_BYTES) {
    return cleanBytes.toString("utf8");
  }
  const tailStr = trimTailUtf8(cleanBytes, TAIL_PREVIEW_BYTES);
  const shownBytes = Buffer.byteLength(tailStr, "utf8");
  const dropped = cleanBytes.subarray(0, cleanBytes.length - shownBytes);
  let newlines = 0;
  for (let i = 0; i < dropped.length; i += 1) {
    if (dropped[i] === 0x0a) newlines += 1;
  }
  const droppedLines = newlines + (dropped.length > 0 && dropped[dropped.length - 1] !== 0x0a ? 1 : 0);
  return (droppedLines > 0 ? `<truncated ${droppedLines} lines>\n` : "") + tailStr;
}

function formatGoStyleDurationSeconds(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3_600);
  const mins = Math.floor((totalSec % 3_600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h${mins}m${secs}s`;
  return `${mins}m${secs}s`;
}

function collectDescendantPids(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  const found: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    try {
      const out = execFileSync("pgrep", ["-P", String(parent)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 500,
      }).trim();
      if (!out) continue;
      for (const line of out.split(/\s+/)) {
        const pid = Number(line);
        if (Number.isInteger(pid) && pid > 1 && !seen.has(pid)) {
          seen.add(pid);
          found.push(pid);
          queue.push(pid);
        }
      }
    } catch {
      // no children
    }
  }
  return found;
}

function killProcessTreeHard(shellPid: number | undefined, wrapperProc: ChildProcess): void {
  const targetPid = shellPid ?? wrapperProc.pid;
  if (targetPid && process.platform !== "win32") {
    const descendants = collectDescendantPids(targetPid);
    try {
      process.kill(-targetPid, "SIGKILL");
    } catch {
      // ignore ESRCH
    }
    for (const dpid of descendants.reverse()) {
      try {
        process.kill(dpid, "SIGKILL");
      } catch {
        // ignore ESRCH
      }
    }
  }
  try {
    wrapperProc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

export type TaskStatusEnum = "RUNNING" | "DONE" | "CANCELED";

export interface SessionNoticeItem {
  ts: string;
  sender: string;
  text: string;
  delivered: boolean;
}

export interface ManagedTaskRecord {
  taskId: string;
  stepIndex: number;
  commandLine: string;
  toolSummary: string;
  isDaemon: boolean;
  startTimeIsoUtc: string;
  lastProgressMs: number;
  status: TaskStatusEnum;
  exitCode: number;
  terminatedBySignal: number | null;
  killedByUser: boolean;
  logPath: string;
  logUri: string;
  stepOutputPath: string;
  cleanChunks: Buffer[];
  cleanByteLength: number;
  // 有界捕获丢弃的中间字节数。
  droppedBytes?: number;
  proc: ChildProcess;
  shellPid?: number;
  backgrounded: boolean;
  fullResultDeliveredViaStatus: boolean;
  waiters: Set<() => void>;
}

// cleanChunks[0] 固定为头部，其余为滚动尾部；总量始终 <= MAX_CAPTURED_BYTES。
function appendBoundedCapture(record: ManagedTaskRecord, buf: Buffer): void {
  if (buf.length === 0) return;
  let head = record.cleanChunks[0] ?? Buffer.alloc(0);
  const tail = record.cleanChunks.slice(1);
  let rest = buf;

  if (head.length < CAPTURE_HEAD_BYTES) {
    const take = Math.min(CAPTURE_HEAD_BYTES - head.length, rest.length);
    head = head.length === 0 ? Buffer.from(rest.subarray(0, take)) : Buffer.concat([head, rest.subarray(0, take)]);
    rest = rest.subarray(take);
  }

  let tailBytes = tail.reduce((sum, part) => sum + part.length, 0);
  const maxTail = MAX_CAPTURED_BYTES - CAPTURE_HEAD_BYTES;
  if (rest.length >= maxTail) {
    record.droppedBytes = (record.droppedBytes ?? 0) + tailBytes + rest.length - maxTail;
    tail.length = 0;
    tail.push(Buffer.from(rest.subarray(rest.length - maxTail)));
    tailBytes = maxTail;
  } else if (rest.length > 0) {
    tail.push(Buffer.from(rest));
    tailBytes += rest.length;
    while (tailBytes > maxTail) {
      const excess = tailBytes - maxTail;
      const first = tail[0]!;
      if (first.length <= excess) {
        record.droppedBytes = (record.droppedBytes ?? 0) + first.length;
        tail.shift();
        tailBytes -= first.length;
      } else {
        record.droppedBytes = (record.droppedBytes ?? 0) + excess;
        tail[0] = first.subarray(excess);
        tailBytes -= excess;
      }
    }
  }

  record.cleanChunks = [head, ...tail];
  record.cleanByteLength = head.length + tailBytes;
}

function getCapturedBytes(record: ManagedTaskRecord): Buffer {
  return Buffer.concat(record.cleanChunks);
}

interface CappedFileState {
  bytes: number;
  truncated: boolean;
}

// 磁盘全量输出逐 chunk 追加，到达上限后停止写入。
function appendCapped(filePath: string, buf: Buffer, state: CappedFileState): void {
  if (state.truncated) return;
  const room = MAX_OUTPUT_FILE_BYTES - state.bytes;
  if (room <= 0) {
    state.truncated = true;
    return;
  }
  const part = buf.length > room ? buf.subarray(0, room) : buf;
  try {
    appendFileSync(filePath, part);
  } catch {
    // 忽略 teardown 后的磁盘错误
    return;
  }
  state.bytes += part.length;
  if (part.length < buf.length || state.bytes >= MAX_OUTPUT_FILE_BYTES) state.truncated = true;
}

export interface SessionTaskContext {
  readonly sessionUuid: string;
  readonly stateRoot: string;
  readonly workspace: string;
  nextStepIndex(): number;
  // 当前 step 序号 (-2 起、每次工具调用 +4), 仅用于 TaskId 步号校验
  currentStepIndex(): number;
  readonly tasksByStep: Map<number, ManagedTaskRecord>;
  pushNotice(notice: SessionNoticeItem): void;
  markNoticeDelivered(sender: string): void;
}

function buildCommandEnv(workspace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PWD: workspace,
    TERM: "dumb",
    COLUMNS: "80",
    LINES: "24",
    PAGER: "cat",
    GIT_PAGER: "cat",
    JJ_PAGER: "cat",
    GIT_EDITOR: "false",
    HGEDITOR: "false",
    JJ_EDITOR: "false",
  };
}

function formatCompletedCommandBody(
  exitCode: number,
  cleanOutput: string,
  includeTimestamps?: { created: string; completed: string },
  droppedBytes = 0,
): string {
  const droppedPrefix = droppedBytes > 0 ? `<dropped ${droppedBytes} bytes>\n` : "";
  const header = includeTimestamps
    ? `Created At: ${includeTimestamps.created}\nCompleted At: ${includeTimestamps.completed}\n`
    : "";
  const payload =
    cleanOutput.length > 0 ? `Command output:\n${cleanOutput}` : "No output from the command.";
  return `${droppedPrefix}${header}Command exited with code ${exitCode}.\n\n${payload}`;
}

export async function executeRunCommand(
  ctx: SessionTaskContext,
  args: Record<string, unknown>,
  holdMs: number,
): Promise<{ text: string; isError?: boolean }> {
  const commandLine = String(args.CommandLine ?? "");
  if (commandLine === "") {
    throw new AgyToolExecutionError("run_command: CommandLine is required");
  }
  const toolSummary = String(args.toolSummary ?? "");
  const isDaemon = args.IsDaemon === true;
  const waitMsRaw = typeof args.WaitMsBeforeAsync === "number" ? args.WaitMsBeforeAsync : 5_000;
  const agyClampedWaitMs = Math.min(10_000, Math.max(500, waitMsRaw));
  const wantsServerHold = !isDaemon && waitMsRaw > 500;
  const effectiveWaitMs = wantsServerHold ? Math.max(agyClampedWaitMs, holdMs) : agyClampedWaitMs;

  const stepIndex = ctx.nextStepIndex();
  const taskId = `${ctx.sessionUuid}/task-${stepIndex}`;
  const tasksDir = join(ctx.stateRoot, "brain", ctx.sessionUuid, ".system_generated", "tasks");
  const stepOutputPath = join(
    ctx.stateRoot,
    "brain",
    ctx.sessionUuid,
    ".system_generated",
    "steps",
    String(stepIndex),
    "output.txt",
  );
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(stepOutputPath, ".."), { recursive: true });
  const logPath = join(tasksDir, `task-${stepIndex}.log`);
  writeFileSync(logPath, "");
  writeFileSync(stepOutputPath, "");

  const createdLocal = formatAgyTimestamp();
  const startUtc = formatAgyUtcTimestamp();
  const env = buildCommandEnv(ctx.workspace);
  const pyBin = detectPythonPtyBin();

  let proc: ChildProcess;
  if (pyBin) {
    proc = spawn(pyBin, ["-c", PYTHON_PTY_SHIM, commandLine], {
      cwd: ctx.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
  } else {
    const shell =
      process.platform === "win32"
        ? process.env.COMSPEC || "cmd.exe"
        : existsSync("/bin/zsh")
          ? "/bin/zsh"
          : process.env.SHELL || "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", commandLine] : ["-c", commandLine];
    proc = spawn(shell, shellArgs, {
      cwd: ctx.workspace,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  const record: ManagedTaskRecord = {
    taskId,
    stepIndex,
    commandLine,
    toolSummary,
    isDaemon,
    startTimeIsoUtc: startUtc,
    lastProgressMs: Date.now(),
    status: "RUNNING",
    exitCode: 0,
    terminatedBySignal: null,
    killedByUser: false,
    logPath,
    logUri: encodeFileUri(logPath),
    stepOutputPath,
    cleanChunks: [Buffer.alloc(0)],
    cleanByteLength: 0,
    droppedBytes: 0,
    proc,
    shellPid: pyBin ? undefined : proc.pid,
    backgrounded: false,
    fullResultDeliveredViaStatus: false,
    waiters: new Set(),
  };

  const logState: CappedFileState = { bytes: 0, truncated: false };
  const outputState: CappedFileState = { bytes: 0, truncated: false };
  let ansiCarry = "";
  const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
  const ingest = (decoded: string, final = false) => {
    let source = ansiCarry + decoded;
    if (final) {
      ansiCarry = "";
    } else {
      // 末尾不完整 ESC 序列留到下一 chunk；其余照旧剥离。
      const completeEnd = lastCompleteAnsiEnd(source);
      const tail = source.slice(completeEnd);
      const escAt = tail.indexOf("\x1b");
      if (escAt >= 0) {
        ansiCarry = tail.slice(escAt);
        source = source.slice(0, completeEnd + escAt);
      } else {
        ansiCarry = "";
      }
    }
    const cleaned = source.replace(ANSI_ESCAPE_RE, "");
    if (cleaned.length === 0) return;
    const cleanBuf = Buffer.from(cleaned, "utf8");
    appendBoundedCapture(record, cleanBuf);
    record.lastProgressMs = Date.now();
    appendCapped(logPath, cleanBuf, logState);
    appendCapped(stepOutputPath, cleanBuf, outputState);
  };
  const onChunk = (chunk: Buffer) => ingest(utf8Decoder.decode(chunk));
  const flushAnsiCarry = () => ingest("", true);

  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);

  if (pyBin && proc.stdio[3]) {
    let ctrlBuf = "";
    proc.stdio[3].on("data", (d: Buffer) => {
      ctrlBuf += d.toString("utf8");
      let nl: number;
      while ((nl = ctrlBuf.indexOf("\n")) >= 0) {
        const line = ctrlBuf.slice(0, nl).trim();
        ctrlBuf = ctrlBuf.slice(nl + 1);
        if (line.startsWith("PID:")) {
          const parsedPid = Number(line.slice(4));
          if (Number.isInteger(parsedPid) && parsedPid > 0) {
            record.shellPid = parsedPid;
          }
        } else if (line.startsWith("SIG:")) {
          const sigNum = Number(line.slice(4));
          if (Number.isInteger(sigNum) && sigNum > 0) {
            record.terminatedBySignal = sigNum;
          }
        }
      }
    });
  }

  const exitPromise = new Promise<void>((resolveExit) => {
    proc.once("close", (code, signal) => {
      flushAnsiCarry();
      if (record.killedByUser) {
        record.status = "CANCELED";
      } else if (
        signal === "SIGINT"
        || signal === "SIGTERM"
        || record.terminatedBySignal === 2
        || record.terminatedBySignal === 15
      ) {
        record.status = "CANCELED";
      } else {
        record.status = "DONE";
      }

      if (typeof code === "number") {
        record.exitCode = code;
      } else if (signal) {
        record.exitCode = 128;
      }
      persistTaskSidecar(record);

      if (record.backgrounded) {
        const tsUtc = formatAgyUtcTimestamp();
        if (record.status === "CANCELED") {
          ctx.pushNotice({
            ts: tsUtc,
            sender: record.taskId,
            text: `Task id "${record.taskId}" was canceled with result:\nTool execution was canceled\nLog: ${record.logUri}`,
            delivered: false,
          });
        } else {
          const cleanOut = getCapturedBytes(record).toString("utf8");
          const rawBody = formatCompletedCommandBody(record.exitCode, cleanOut, undefined, record.droppedBytes ?? 0);
          const truncatedBody = truncateAndPersistOutput(rawBody, record.stepOutputPath);
          ctx.pushNotice({
            ts: tsUtc,
            sender: record.taskId,
            text: `Task id "${record.taskId}" finished with result:\n${truncatedBody}\nLog: ${record.logUri}`,
            delivered: false,
          });
        }
      }

      for (const w of [...record.waiters]) w();
      record.waiters.clear();
      resolveExit();
    });
  });

  // Wait up to effectiveWaitMs for synchronous completion
  const finishedInTime = await Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolveTimer) => {
      const t = setTimeout(() => resolveTimer(false), effectiveWaitMs);
      void exitPromise.finally(() => clearTimeout(t));
    }),
  ]);

  if (finishedInTime) {
    if (record.status === "CANCELED") {
      return { text: "Tool execution was canceled", isError: true };
    }
    const completedLocal = formatAgyTimestamp();
    const cleanOut = getCapturedBytes(record).toString("utf8");
    const fullFormatted = formatCompletedCommandBody(record.exitCode, cleanOut, {
      created: createdLocal,
      completed: completedLocal,
    }, record.droppedBytes ?? 0);
    return {
      text: truncateAndPersistOutput(fullFormatted, record.stepOutputPath),
    };
  }

  // Transition to background task
  record.backgrounded = true;
  ctx.tasksByStep.set(stepIndex, record);
  persistTaskSidecar(record);

  const currentCleanBytes = getCapturedBytes(record);
  const preview = buildTailLogPreview(currentCleanBytes);
  let out =
    `Tool is running as a background task with task id: ${record.taskId}\n` +
    `Task logs are available at: ${record.logUri}`;
  if (preview.length > 0) {
    out += `\nLog output:\n${preview}`;
  }
  if (wantsServerHold) {
    const holdSec = Math.round(holdMs / 1_000);
    out += `\n\n[Server held ${holdSec}s; task is still running. Call manage_task with Action "status" and TaskId "${record.taskId}" to wait up to another ${holdSec}s.]`;
  }

  return { text: out };
}

function parseTaskIdForSession(
  rawTaskId: string,
  ctx: SessionTaskContext,
): { resolvedId: string; stepIndex: number } {
  if (!rawTaskId) {
    throw new AgyToolExecutionError(
      'TaskId is required for this action; run the "list" action to get the ids of the running tasks',
    );
  }

  let localPart: string;
  if (rawTaskId.includes("/")) {
    const parts = rawTaskId.split("/");
    if (parts.length !== 2) {
      throw new AgyToolExecutionError(`invalid local task ID format: "${parts.slice(1).join("/")}"`);
    }
    const [sid, rest] = parts as [string, string];
    if (sid !== ctx.sessionUuid) {
      throw new AgyToolExecutionError(`task "${rawTaskId}" belongs to a different conversation`);
    }
    if (!rest) {
      throw new AgyToolExecutionError('invalid local task ID format: ""');
    }
    localPart = rest;
  } else {
    if (!rawTaskId.startsWith("task-")) {
      throw new AgyToolExecutionError(`invalid task ID format: "${rawTaskId}"`);
    }
    localPart = rawTaskId;
  }

  if (!localPart.startsWith("task-")) {
    throw new AgyToolExecutionError(`invalid local task ID format: "${localPart}"`);
  }

  const numStr = localPart.slice("task-".length);
  if (!/^[+-]?\d+$/.test(numStr)) {
    throw new AgyToolExecutionError(
      `invalid step index in local task ID "${localPart}": strconv.Atoi: parsing "${numStr}": invalid syntax`,
    );
  }
  const stepIndex = Number(numStr);
  if (!Number.isSafeInteger(stepIndex)) {
    throw new AgyToolExecutionError(
      `invalid step index in local task ID "${localPart}": strconv.Atoi: parsing "${numStr}": value out of range`,
    );
  }

  return {
    resolvedId: `${ctx.sessionUuid}/task-${stepIndex}`,
    stepIndex,
  };
}

function waitOnTaskRecord(record: ManagedTaskRecord, timeoutMs: number): Promise<void> {
  if (record.status !== "RUNNING") return Promise.resolve();
  return new Promise((resolveWait) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      record.waiters.delete(finish);
      resolveWait();
    };
    const timer = setTimeout(finish, timeoutMs);
    record.waiters.add(finish);
  });
}

// ── 任务元数据 sidecar ────────────────────────────────────────────
// stdio 客户端可能每轮对话重启服务子进程，内存态 tasksByStep 会随之丢失。
// 每个任务在日志旁写一份 <task-N>.json，新进程据此回答「上一轮的任务现在怎样了」。
export interface TaskSidecar {
  taskId: string;
  stepIndex: number;
  commandLine: string;
  toolSummary: string;
  isDaemon: boolean;
  startTimeIsoUtc: string;
  status: TaskStatusEnum;
  exitCode: number;
  shellPid?: number;
  logPath: string;
  logUri: string;
}

function sidecarPathOf(logPath: string): string {
  return logPath.endsWith(".log") ? `${logPath.slice(0, -4)}.json` : `${logPath}.json`;
}

// 原子写：先写 .tmp 再 rename，避免服务进程被强杀时留下半截 JSON。
function persistTaskSidecar(record: ManagedTaskRecord): void {
  const target = sidecarPathOf(record.logPath);
  const payload: TaskSidecar = {
    taskId: record.taskId,
    stepIndex: record.stepIndex,
    commandLine: record.commandLine,
    toolSummary: record.toolSummary,
    isDaemon: record.isDaemon,
    startTimeIsoUtc: record.startTimeIsoUtc,
    status: record.status,
    exitCode: record.exitCode,
    ...(record.shellPid ? { shellPid: record.shellPid } : {}),
    logPath: record.logPath,
    logUri: record.logUri,
  };
  try {
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, target);
  } catch {
    // 落盘失败不影响任务主流程，只是失去跨进程查询能力。
  }
}

function tasksDirOf(ctx: SessionTaskContext): string {
  return join(ctx.stateRoot, "brain", ctx.sessionUuid, ".system_generated", "tasks");
}

// 读取上一进程留下的任务元数据；损坏或半截文件直接忽略。
export function readTaskSidecars(ctx: SessionTaskContext): TaskSidecar[] {
  const dir = tasksDirOf(ctx);
  if (!existsSync(dir)) return [];
  const out: TaskSidecar[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as TaskSidecar);
    } catch {
      // 忽略损坏的 sidecar。
    }
  }
  return out.sort((a, b) => a.stepIndex - b.stepIndex);
}

function isPidAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogTailText(logPath: string, maxChars = TAIL_PREVIEW_BYTES * 2): string {
  try {
    const size = statSync(logPath).size;
    const buf = readFileSync(logPath);
    const start = Math.max(0, size - maxChars * 4);
    return stripAnsiAndDecode(buf.subarray(start)).slice(-maxChars);
  } catch {
    return "";
  }
}

export async function executeManageTask(
  ctx: SessionTaskContext,
  args: Record<string, unknown>,
  holdMs: number,
): Promise<{ text: string; suppressNoticeTaskId?: string }> {
  const action = String(args.Action ?? "");
  const created = formatAgyTimestamp();
  // 上一进程留下的 task 元数据；内存里没有的才当作 orphan。
  const orphanSidecars = readTaskSidecars(ctx).filter((s) => !ctx.tasksByStep.has(s.stepIndex));

  if (action === "list") {
    const running = [...ctx.tasksByStep.values()]
      .filter((t) => t.status === "RUNNING")
      .sort((a, b) => a.stepIndex - b.stepIndex);
    // 跨进程存活的任务：只有 pid 还活着才算 RUNNING。
    const ghostRunning = orphanSidecars.filter((s) => isPidAlive(s.shellPid));
    const completed = formatAgyTimestamp();
    if (running.length === 0 && ghostRunning.length === 0) {
      return {
        text: `Created At: ${created}\nCompleted At: ${completed}\nNo background tasks are currently running.`,
      };
    }
    const items = [
      ...running.map((t) => ({
        taskId: t.taskId,
        toolName: "run_command",
        toolSummary: t.toolSummary,
        description: t.commandLine,
        startTime: t.startTimeIsoUtc,
        logUri: t.logUri,
        ...(t.isDaemon ? { isDaemon: true } : {}),
      })),
      ...ghostRunning.map((s) => ({
        taskId: s.taskId,
        toolName: "run_command",
        toolSummary: s.toolSummary,
        description: s.commandLine,
        startTime: s.startTimeIsoUtc,
        logUri: s.logUri,
        ...(s.isDaemon ? { isDaemon: true } : {}),
        restoredFromDisk: true,
      })),
    ];
    return {
      text:
        `Created At: ${created}\nCompleted At: ${completed}\n` +
        `You have ${items.length} background task(s) currently running:\n` +
        JSON.stringify(items),
    };
  }

  const rawTaskId = typeof args.TaskId === "string" ? args.TaskId : "";
  const { resolvedId, stepIndex } = parseTaskIdForSession(rawTaskId, ctx);
  const totalSteps = ctx.currentStepIndex();
  const record = ctx.tasksByStep.get(stepIndex);

  if (action === "status") {
    if (!record) {
      // 进程重启后的任务：从 sidecar + 日志尾部还原状态。
      const ghost = orphanSidecars.find((s) => s.stepIndex === stepIndex);
      if (ghost) {
        const alive = isPidAlive(ghost.shellPid);
        const completed = formatAgyTimestamp();
        const tail = readLogTailText(ghost.logPath);
        let out =
          `Created At: ${created}\nCompleted At: ${completed}\n` +
          `Task: ${ghost.taskId}\n` +
          `Status: ${alive ? "RUNNING" : "EXITED (process no longer alive)"}\n` +
          `Log: ${ghost.logUri}\n`;
        if (tail.length > 0) out += `Log output:\n${tail}\n`;
        out += alive
          ? `\n[stdio server was restarted; task restored from disk. send_input is unavailable, kill still works.]`
          : `\n[stdio server was restarted; exit code: ${ghost.exitCode}]`;
        return { text: out, suppressNoticeTaskId: ghost.taskId };
      }
      if (stepIndex < 0 || stepIndex > totalSteps) {
        throw new AgyToolExecutionError(
          `task "${resolvedId}" refers to a non-existent step index ${stepIndex} (total steps: ${totalSteps})`,
        );
      }
      const completed = formatAgyTimestamp();
      return {
        text: `Created At: ${created}\nCompleted At: ${completed}\nTask: ${resolvedId}\nStatus: DONE\n`,
      };
    }

    if (record.status === "RUNNING" && holdMs > 0) {
      await waitOnTaskRecord(record, holdMs);
    }

    // Deliver the full result (including exact exit code) the first time status observes completion
    if (record.status === "DONE" && !record.fullResultDeliveredViaStatus) {
      record.fullResultDeliveredViaStatus = true;
      ctx.markNoticeDelivered(record.taskId);
      const cleanOut = getCapturedBytes(record).toString("utf8");
      const rawBody = formatCompletedCommandBody(record.exitCode, cleanOut, undefined, record.droppedBytes ?? 0);
      const truncatedBody = truncateAndPersistOutput(rawBody, record.stepOutputPath);
      return {
        text: `Task id "${record.taskId}" finished with result:\n${truncatedBody}\nLog: ${record.logUri}`,
        suppressNoticeTaskId: record.taskId,
      };
    }

    const completed = formatAgyTimestamp();
    const cleanBytes = getCapturedBytes(record);
    const preview = buildTailLogPreview(cleanBytes);
    let out =
      `Created At: ${created}\nCompleted At: ${completed}\n` +
      `Task: ${record.taskId}\n` +
      `Status: ${record.status}\n` +
      `Log: ${record.logUri}\n`;
    if (preview.length > 0) {
      const ago = formatGoStyleDurationSeconds(Date.now() - record.lastProgressMs);
      out += `Log output:\n${preview}\nLast progress: ${ago} ago\n`;
    }
    if (record.status === "RUNNING" && holdMs > 0) {
      const holdSec = Math.round(holdMs / 1_000);
      out += `\n[Server held ${holdSec}s; task is still running. Call manage_task with Action "status" and TaskId "${record.taskId}" to wait up to another ${holdSec}s.]`;
    }
    return { text: out, suppressNoticeTaskId: record.taskId };
  }

  if (action === "send_input") {
    const input = typeof args.Input === "string" ? args.Input : "";
    if (input === "") {
      throw new AgyToolExecutionError('Input is required for the "send_input" action');
    }
    if (!record) {
      const ghost = orphanSidecars.find((s) => s.stepIndex === stepIndex);
      if (ghost) {
        throw new AgyToolExecutionError(
          `cannot send_input task "${ghost.taskId}": process was detached when the stdio server restarted; stdin is not available`,
        );
      }
      throw new AgyToolExecutionError(
        `task "${resolvedId}" refers to a non-existent step index ${stepIndex} (total steps: ${totalSteps})`,
      );
    }
    if (record.status !== "RUNNING") {
      throw new AgyToolExecutionError(
        `cannot send_input task "${record.taskId}": task is not running (status: ${record.status})`,
      );
    }
    if (!record.proc.stdin || record.proc.stdin.destroyed || !record.proc.stdin.writable) {
      throw new AgyToolExecutionError(`cannot send_input task "${record.taskId}": stdin is closed`);
    }
    record.proc.stdin.write(Buffer.from(input, "utf8"));
    const completed = formatAgyTimestamp();
    return {
      text: `Created At: ${created}\nCompleted At: ${completed}\nInput sent to task "${record.taskId}".`,
    };
  }

  if (action === "kill") {
    if (!record) {
      // 进程重启后的任务：按 pid 直接杀，并更新 sidecar 状态。
      const ghost = orphanSidecars.find((s) => s.stepIndex === stepIndex);
      if (ghost && isPidAlive(ghost.shellPid)) {
        const pid = ghost.shellPid!;
        let killed = false;
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, "SIGKILL");
            killed = true;
          } catch {
            // 尝试下一个目标（进程组 → 单进程）。
          }
        }
        if (!killed) {
          throw new AgyToolExecutionError(`cannot kill task "${ghost.taskId}": failed to signal pid ${pid}`);
        }
        try {
          writeFileSync(sidecarPathOf(ghost.logPath), JSON.stringify({ ...ghost, status: "CANCELED", exitCode: 137 }));
        } catch {
          // sidecar 更新失败不影响杀进程。
        }
        const completed = formatAgyTimestamp();
        return {
          text: `Created At: ${created}\nCompleted At: ${completed}\nTask "${ghost.taskId}" cancelled (restored from disk).`,
          suppressNoticeTaskId: ghost.taskId,
        };
      }
      throw new AgyToolExecutionError(
        `task "${resolvedId}" refers to a non-existent step index ${stepIndex} (total steps: ${totalSteps})`,
      );
    }
    if (record.status !== "RUNNING") {
      throw new AgyToolExecutionError(
        `cannot kill task "${record.taskId}": task is not running (status: ${record.status})`,
      );
    }
    record.killedByUser = true;
    killProcessTreeHard(record.shellPid, record.proc);
    await waitOnTaskRecord(record, 1_500);
    record.status = "CANCELED";
    persistTaskSidecar(record);
    const completed = formatAgyTimestamp();
    return {
      text: `Created At: ${created}\nCompleted At: ${completed}\nTask "${record.taskId}" cancelled.`,
      suppressNoticeTaskId: record.taskId,
    };
  }

  throw new AgyToolExecutionError(`unsupported action: ${action}`);
}

export function killAllSessionTasks(tasksByStep: Map<number, ManagedTaskRecord>): void {
  for (const record of tasksByStep.values()) {
    if (record.status === "RUNNING") {
      record.killedByUser = true;
      killProcessTreeHard(record.shellPid, record.proc);
      record.status = "CANCELED";
      for (const w of [...record.waiters]) w();
      record.waiters.clear();
    }
  }
}
