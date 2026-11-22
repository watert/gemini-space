import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, extname, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { AgyToolExecutionError, formatAgyTimestamp } from "./agy-tool-schemas.js";

export interface InlineMediaItem {
  mimeType: string;
  data: string;
}

export interface FileToolExecutionOutput {
  text: string;
  images: InlineMediaItem[];
}

const MAX_READ_LINES = 800;
const MAX_READ_BYTES = 46_080;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
const MAX_HEADER_BYTES = 512; // 头部嗅探缓冲：所有 magic 都在前 512 字节内
const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8 MiB：超过则不再 base64 内联

function parseAbsoluteToolPath(rawPath: string): string {
  if (rawPath.startsWith("file://")) {
    try {
      return fileURLToPath(rawPath);
    } catch {
      // fall through
    }
  }
  if (!isAbsolute(rawPath)) {
    throw new AgyToolExecutionError(
      `declaring permissions: failed to parse path: ${rawPath} must be an absolute path: path is not absolute`,
    );
  }
  return rawPath;
}

function cleanDisplayPath(rawPath: string): string {
  const cleaned = normalize(rawPath);
  if (cleaned.length > 1 && cleaned.endsWith("/")) {
    return cleaned.slice(0, -1);
  }
  return cleaned;
}

// 只接收文件头部缓冲（前 512 字节）即可判定：现有 magic 均落在前 12 字节内
function sniffMultimodalMime(buf: Buffer, filePath: string): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 6
    && buf[0] === 0x47
    && buf[1] === 0x49
    && buf[2] === 0x46
    && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39)
    && buf[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    buf.length >= 12
    && buf.toString("ascii", 0, 4) === "RIFF"
    && buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    buf.length >= 4
    && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00)
      || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  if (buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  if (
    buf.length >= 12
    && buf.toString("ascii", 0, 4) === "RIFF"
    && buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    return "audio/wav";
  }
  if (
    (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3")
    || (buf.length >= 2 && buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2))
  ) {
    return "audio/mpeg";
  }
  // ISO BMFF (MP4 / MOV / 3GP)
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "heic" || brand === "heix" || brand === "mif1") {
      return null;
    }
    const ext = extname(filePath).toLowerCase();
    if (ext === ".mov" || ext === ".qt") return "video/quicktime";
    if (ext === ".mp4" || ext === ".m4a") return "video/mp4";
    if (ext === ".m4v") return "video/x-m4v";
    if (ext === ".3gp") return "video/3gpp";
    if (ext === "" || ext === ".txt" || ext === ".bin" || ext === ".dat") return null;
    return "video/mp4";
  }
  return null;
}

function decodeTextStrict(buf: Buffer, filePath: string): string {
  // UTF-16 BOM support
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: true }).decode(buf.subarray(2));
  }
  if (buf.includes(0x00)) {
    throw new AgyToolExecutionError(
      `file "${filePath}" appears to be a binary file (application/octet-stream, ${buf.length} bytes) and cannot be read as text`,
    );
  }
  try {
    let text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    return text;
  } catch {
    throw new AgyToolExecutionError(
      `file "${filePath}" appears to be a binary file (text/plain; charset=utf-8, ${buf.length} bytes) and cannot be read as text`,
    );
  }
}

function charByteStarts(str: string): number[] {
  const starts = [0];
  let offset = 0;
  for (const ch of str) {
    offset += Buffer.byteLength(ch, "utf8");
    starts.push(offset);
  }
  return starts;
}

function largestCharStartLE(starts: number[], bytePos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = starts[mid]!;
    if (val <= bytePos) {
      best = val;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function sliceRenderedBlob(blob: string, starts: number[], offset: number, sliceEnd: number): string {
  const chars = [...blob];
  let i = 0;
  while (i < chars.length && starts[i + 1]! <= offset) {
    i += 1;
  }
  let out = "";
  if (i < chars.length && starts[i]! < offset) {
    out += "\uFFFD";
    i += 1;
  }
  while (i < chars.length && starts[i + 1]! <= sliceEnd) {
    out += chars[i]!;
    i += 1;
  }
  return out;
}

// 只读文件头部小缓冲；读完即关闭 fd，避免为嗅探付出整文件读取的代价
function readFileHeader(resolvedPath: string): Buffer {
  const header = Buffer.alloc(MAX_HEADER_BYTES);
  let fd: number;
  try {
    fd = openSync(resolvedPath, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new AgyToolExecutionError(`failed to read file: open ${resolvedPath}: permission denied`);
    }
    throw new AgyToolExecutionError(`failed to read file: ${(err as Error).message}`);
  }
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, header, 0, MAX_HEADER_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  return header.subarray(0, bytesRead);
}

// 确认是媒体或确认是文本后，才走原有整文件读取与错误文案
function readWholeFile(resolvedPath: string): Buffer {
  try {
    return readFileSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new AgyToolExecutionError(`failed to read file: open ${resolvedPath}: permission denied`);
    }
    throw new AgyToolExecutionError(`failed to read file: ${(err as Error).message}`);
  }
}

export function executeReadFile(args: Record<string, unknown>): FileToolExecutionOutput {
  const rawPath = String(args.Path ?? "");
  if (rawPath === "") {
    throw new AgyToolExecutionError("Path is required");
  }
  const resolvedPath = parseAbsoluteToolPath(rawPath);

  const startLineArg = typeof args.StartLine === "number" ? args.StartLine : undefined;
  const endLineArg = typeof args.EndLine === "number" ? args.EndLine : undefined;
  const byteOffsetArg = typeof args.ByteOffset === "number" ? args.ByteOffset : undefined;

  if (startLineArg !== undefined && startLineArg < 1) {
    throw new AgyToolExecutionError(`invalid StartLine ${startLineArg}: must be at least 1`);
  }
  if (endLineArg !== undefined && endLineArg < 1) {
    throw new AgyToolExecutionError(`invalid EndLine ${endLineArg}: must be at least 1`);
  }
  if (startLineArg !== undefined && endLineArg !== undefined && startLineArg > endLineArg) {
    throw new AgyToolExecutionError(
      `invalid line range: StartLine ${startLineArg} is greater than EndLine ${endLineArg}`,
    );
  }
  if (byteOffsetArg !== undefined && byteOffsetArg < 0) {
    throw new AgyToolExecutionError(`invalid ByteOffset ${byteOffsetArg}: must be non-negative`);
  }

  let st;
  try {
    st = statSync(resolvedPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AgyToolExecutionError("file does not exist");
    }
    if (code === "ENOTDIR") {
      throw new AgyToolExecutionError(`failed to access file: stat ${resolvedPath}: not a directory`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new AgyToolExecutionError(`failed to access file: stat ${resolvedPath}: permission denied`);
    }
    throw new AgyToolExecutionError(
      `failed to access file: stat ${resolvedPath}: ${(err as Error).message}`,
    );
  }

  if (st.isDirectory()) {
    throw new AgyToolExecutionError("path is a directory, not a file");
  }
  if (!st.isFile()) {
    throw new AgyToolExecutionError("path is a device, pipe, or socket, not a standard file");
  }
  if (st.size > MAX_FILE_SIZE_BYTES) {
    const mb = (st.size / (1024 * 1024)).toFixed(1);
    throw new AgyToolExecutionError(
      `cannot read "${resolvedPath}": file size (${st.size} bytes / ${mb} MB) exceeds the 100 MB limit`,
    );
  }

  const created = formatAgyTimestamp();
  // 两段式读：先只读 512 字节头部用于嗅探，避免为了判定类型把整文件读进内存
  const fileHeader = readFileHeader(resolvedPath);

  const mediaMime = sniffMultimodalMime(fileHeader, resolvedPath);
  if (mediaMime) {
    // 媒体超过上限时拒绝内联，防止 base64 结果撑爆模型上下文
    if (st.size > MAX_MEDIA_BYTES) {
      throw new AgyToolExecutionError(
        `file too large for inline media (${st.size} bytes > 8 MiB); use run_command with a tool like sips/ffprobe to inspect`,
      );
    }
    const media = readWholeFile(resolvedPath);
    const completed = formatAgyTimestamp();
    return {
      text: `Created At: ${created}\nCompleted At: ${completed}\nShowing binary file of type ${mediaMime}`,
      images: [{ mimeType: mediaMime, data: media.toString("base64") }],
    };
  }

  // 非媒体 magic 但头部含 NUL：按未知二进制拒读，不猜编码
  // （UTF-16 文本同样含 NUL，一律拒读；仅在有 BOM 时补一句说明，不做解码）
  if (fileHeader.includes(0x00)) {
    let message =
      "binary file detected (no inline media support for this type); refusing to render as text";
    if (
      (fileHeader[0] === 0xff && fileHeader[1] === 0xfe)
      || (fileHeader[0] === 0xfe && fileHeader[1] === 0xff)
    ) {
      message += " (UTF-16 text contains NUL bytes and is not decoded)";
    }
    throw new AgyToolExecutionError(message);
  }

  const raw = readWholeFile(resolvedPath);

  if (raw.length === 0) {
    const completed = formatAgyTimestamp();
    return {
      text: `Created At: ${created}\nCompleted At: ${completed}\nFile is empty`,
      images: [],
    };
  }

  let text = decodeTextStrict(raw, resolvedPath);
  if (text === "") {
    const completed = formatAgyTimestamp();
    return {
      text: `Created At: ${created}\nCompleted At: ${completed}\nFile is empty`,
      images: [],
    };
  }

  const trailingNewline = text.endsWith("\n");
  if (trailingNewline) {
    text = text.slice(0, -1);
  }
  const lines = text.split("\n");
  const total = lines.length;

  const start = Math.min(startLineArg ?? 1, total);
  let end = endLineArg !== undefined ? Math.min(endLineArg, total) : total;
  end = Math.min(end, start + MAX_READ_LINES - 1);

  const rendered: string[] = [];
  for (let i = start; i <= end; i += 1) {
    rendered.push(`${i}: ${lines[i - 1]!}`);
  }
  const blob = rendered.join("\n");
  const starts = charByteStarts(blob);
  const blobLen = starts[starts.length - 1]!;

  const offset = byteOffsetArg ?? 0;
  if (offset > blobLen) {
    throw new AgyToolExecutionError(
      `invalid ByteOffset: offset ${offset} is beyond the content length (${blobLen} bytes) of lines ${start}-${end}`,
    );
  }

  const truncated = offset + MAX_READ_BYTES < blobLen;
  const sliceEnd = truncated ? largestCharStartLE(starts, offset + MAX_READ_BYTES) : blobLen;
  let body = sliceRenderedBlob(blob, starts, offset, sliceEnd);

  if (!truncated && !trailingNewline && end === total) {
    body += "\n(no newline at end of file)";
  }

  let header: string;
  if (offset === 0 && !truncated) {
    header = `Showing lines ${start}-${end} of ${total}`;
  } else {
    header =
      `Partial read (lines ${start}-${end} of ${total}). ` +
      `Showing bytes ${offset}-${sliceEnd} of ${blobLen} in this line range`;
    if (truncated) {
      header +=
        `, truncated at the 46080-byte limit. To read the rest of this line range, call this tool again with the same StartLine and EndLine and ByteOffset=${sliceEnd}`;
    }
    header += ".";
  }

  const completed = formatAgyTimestamp();
  return {
    text: `Created At: ${created}\nCompleted At: ${completed}\n${header}\n${body}`,
    images: [],
  };
}

function writeInPlacePreservingMode(filePath: string, data: Buffer): void {
  const fd = openSync(filePath, "r+");
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, data, 0, data.length, 0);
  } finally {
    closeSync(fd);
  }
}

export function executeWriteFile(args: Record<string, unknown>): FileToolExecutionOutput {
  const rawPath = String(args.Path ?? "");
  const targetPath = parseAbsoluteToolPath(rawPath);
  const cleanPath = cleanDisplayPath(targetPath);
  const content = String(args.Content ?? "");
  const overwrite = args.Overwrite === true;
  const append = args.Append === true;

  if (overwrite && append) {
    throw new AgyToolExecutionError("Overwrite and Append cannot both be true");
  }

  const created = formatAgyTimestamp();

  let existingStat = null;
  try {
    existingStat = statSync(cleanPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (code === "ENOTDIR") {
        throw new AgyToolExecutionError(`mkdir ${dirname(cleanPath)}: not a directory`);
      }
      if (code === "EACCES" || code === "EPERM") {
        throw new AgyToolExecutionError(`open ${rawPath}: permission denied`);
      }
      throw new AgyToolExecutionError((err as Error).message);
    }
  }

  if (existingStat?.isDirectory()) {
    throw new AgyToolExecutionError(`${rawPath} is a directory, not a file`);
  }

  const parentDir = dirname(cleanPath);
  try {
    mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR" || code === "EEXIST") {
      throw new AgyToolExecutionError(`mkdir ${parentDir}: not a directory`);
    }
    throw new AgyToolExecutionError(`mkdir ${parentDir}: ${(err as Error).message}`);
  }

  if (existingStat) {
    if (!overwrite && !append) {
      throw new AgyToolExecutionError(
        `${rawPath} already exists. To overwrite it, retry with Overwrite=true. To edit it, view its contents first and use a code edit tool. Otherwise, choose a different file name`,
      );
    }

    try {
      if (append) {
        const existingBytes = readFileSync(cleanPath);
        const prefix =
          existingBytes.length > 0 && existingBytes[existingBytes.length - 1] !== 0x0a ? "\n" : "";
        const merged = Buffer.concat([existingBytes, Buffer.from(prefix + content, "utf8")]);
        writeInPlacePreservingMode(cleanPath, merged);
      } else {
        writeInPlacePreservingMode(cleanPath, Buffer.from(content, "utf8"));
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new AgyToolExecutionError(`open ${rawPath}: permission denied`);
      }
      throw new AgyToolExecutionError((err as Error).message);
    }
  } else {
    try {
      writeFileSync(cleanPath, Buffer.from(content, "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new AgyToolExecutionError(`open ${rawPath}: permission denied`);
      }
      throw new AgyToolExecutionError((err as Error).message);
    }
  }

  const completed = formatAgyTimestamp();
  return {
    text: `Created At: ${created}\nCompleted At: ${completed}\nCreated file.`,
    images: [],
  };
}

type EolMode = "lf" | "crlf" | "mixed";

function detectEolMode(content: string): EolMode {
  if (!content.includes("\r\n")) return "lf";
  let lfCount = 0;
  let crlfCount = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") {
      lfCount += 1;
      if (i > 0 && content[i - 1] === "\r") crlfCount += 1;
    }
  }
  return crlfCount === lfCount ? "crlf" : "mixed";
}

function findNonOverlappingIndices(hay: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let idx = 0;
  while (idx <= hay.length - needle.length) {
    const found = hay.indexOf(needle, idx);
    if (found < 0) break;
    hits.push(found);
    idx = found + needle.length;
  }
  return hits;
}

function spliceNormalizedIntoRaw(
  raw: string,
  hay: string,
  needle: string,
  repl: string,
): { out: string; count: number; firstRawIdx: number } {
  const indexMap = new Int32Array(hay.length + 1);
  let r = 0;
  for (let i = 0; i <= hay.length; i += 1) {
    indexMap[i] = r;
    if (i < hay.length) {
      if (hay[i] === "\n" && raw[r] === "\r" && raw[r + 1] === "\n") {
        r += 2;
      } else {
        r += 1;
      }
    }
  }
  const hits = findNonOverlappingIndices(hay, needle);
  let out = raw;
  for (let k = hits.length - 1; k >= 0; k -= 1) {
    const hitIdx = hits[k]!;
    const start = indexMap[hitIdx]!;
    const end = indexMap[hitIdx + needle.length]!;
    out = out.slice(0, start) + repl + out.slice(end);
  }
  return {
    out,
    count: hits.length,
    firstRawIdx: hits.length > 0 ? indexMap[hits[0]!]! : -1,
  };
}

function literalReplaceAll(
  raw: string,
  target: string,
  repl: string,
): { out: string; count: number; firstRawIdx: number } {
  const hits = findNonOverlappingIndices(raw, target);
  if (hits.length === 0) return { out: raw, count: 0, firstRawIdx: -1 };
  let out = raw;
  for (let k = hits.length - 1; k >= 0; k -= 1) {
    const pos = hits[k]!;
    out = out.slice(0, pos) + repl + out.slice(pos + target.length);
  }
  return { out, count: hits.length, firstRawIdx: hits[0]! };
}

function splitLineTokens(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function computeLineDiffCounts(oldStr: string, newStr: string): { added: number; removed: number } {
  const a = splitLineTokens(oldStr);
  const b = splitLineTokens(newStr);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return { added: m, removed: n };
  }
  // Exact O(n*m) LCS for typical files; bounded memory fallback if very large
  if (n * m > 25_000_000) {
    let prefix = 0;
    while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) {
      suffix += 1;
    }
    const common = prefix + suffix;
    return { added: m - common, removed: n - common };
  }
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    const ai = a[i - 1];
    for (let j = 1; j <= m; j += 1) {
      cur[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  const common = prev[m]!;
  return { added: m - common, removed: n - common };
}

export function executeEditFile(args: Record<string, unknown>): FileToolExecutionOutput {
  const rawPath = String(args.Path ?? "");
  const resolvedPath = parseAbsoluteToolPath(rawPath);
  const cleanPath = cleanDisplayPath(resolvedPath);
  const target = String(args.Target ?? "");
  const replacement = String(args.Replacement ?? "");

  const created = formatAgyTimestamp();

  if (!existsSync(cleanPath)) {
    // Distinguish dangling symlink (existsSync false while lstatSync succeeds) -> same agy message
    try {
      lstatSync(cleanPath);
    } catch {
      // ignore
    }
    throw new AgyToolExecutionError(
      `${cleanPath} does not exist; the file may have been moved, renamed, or deleted`,
    );
  }

  let st;
  try {
    st = statSync(cleanPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new AgyToolExecutionError(`open ${cleanPath}: permission denied`);
    }
    throw new AgyToolExecutionError((err as Error).message);
  }

  if (st.isDirectory()) {
    throw new AgyToolExecutionError(`${cleanPath} is a directory, not a file`);
  }
  if (!st.isFile()) {
    throw new AgyToolExecutionError(`${cleanPath} is a device, pipe, or socket, not a standard file`);
  }

  let rawBytes: Buffer;
  try {
    rawBytes = readFileSync(cleanPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new AgyToolExecutionError(`open ${cleanPath}: permission denied`);
    }
    throw new AgyToolExecutionError(`failed to read file: ${(err as Error).message}`);
  }

  if (rawBytes.includes(0x00)) {
    throw new AgyToolExecutionError(
      "failed to read file: while decoding file, failed to detect charset with sufficient confidence",
    );
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    throw new AgyToolExecutionError(
      "failed to read file: while decoding file, failed to detect charset with sufficient confidence",
    );
  }

  const mode = detectEolMode(content);
  let replaced: { out: string; count: number; firstRawIdx: number };

  if (mode === "mixed") {
    replaced = literalReplaceAll(content, target, replacement);
  } else {
    const hay = content.replace(/\r\n/g, "\n");
    const needle = target.replace(/\r\n/g, "\n");
    let repl = replacement.replace(/\r\n/g, "\n");
    if (hay.includes(needle)) {
      if (mode === "crlf") repl = repl.replace(/\n/g, "\r\n");
      replaced = spliceNormalizedIntoRaw(content, hay, needle, repl);
    } else {
      let fallbackRepl = replacement.replace(/\r\n/g, "\n");
      if (mode === "crlf") fallbackRepl = fallbackRepl.replace(/\n/g, "\r\n");
      replaced = literalReplaceAll(content, target, fallbackRepl);
    }
  }

  if (replaced.count === 0) {
    throw new AgyToolExecutionError(
      "target content not found in the file; the Target must exactly match existing file text, including whitespace",
    );
  }

  let startLine = 1;
  for (let i = 0; i < replaced.firstRawIdx; i += 1) {
    if (content[i] === "\n") startLine += 1;
  }

  const { added, removed } = computeLineDiffCounts(content, replaced.out);

  try {
    writeInPlacePreservingMode(cleanPath, Buffer.from(replaced.out, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new AgyToolExecutionError(`open ${cleanPath}: permission denied`);
    }
    throw new AgyToolExecutionError((err as Error).message);
  }

  const completed = formatAgyTimestamp();
  const noun = replaced.count === 1 ? "replacement" : "replacements";
  return {
    text: `Created At: ${created}\nCompleted At: ${completed}\nMade ${replaced.count} ${noun} in ${cleanPath} starting at line ${startLine} (+${added}/-${removed} lines).`,
    images: [],
  };
}
