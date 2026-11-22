export interface AgyFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  parametersJsonSchema?: Record<string, unknown>;
}

const ARTIFACT_METADATA_PROPERTIES = {
  RequestFeedback: {
    type: "BOOLEAN",
    description:
      "Whether to request user feedback on this artifact if its contents are executable (e.g., a plan). The user is given a 'Proceed' button to execute it.",
  },
  Summary: {
    type: "STRING",
    description: "Detailed multi-line summary of the artifact's contents and purpose.",
  },
  UserFacing: {
    type: "BOOLEAN",
    description: "Whether this artifact should be presented to the user.",
  },
} as const;

const ARTIFACT_METADATA_REQUIRED = ["Summary", "UserFacing", "RequestFeedback"] as const;

/**
 * Verbatim built-in tool declarations extracted from `agy 1.5.10`.
 */
export const AGY_BUILTIN_DECLARATIONS: readonly AgyFunctionDeclaration[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a text, image, pdf, video, or audio file. Each read returns at most 800 lines or 46080 bytes.",
    parameters: {
      type: "OBJECT",
      properties: {
        ByteOffset: {
          type: "INTEGER",
          description:
            "Byte offset into the line range. Use to continue reading when content is truncated by the byte limit.",
        },
        EndLine: {
          type: "INTEGER",
          description:
            "End line to read (inclusive). Omit to read until the end of the file, within the per-read limits.",
        },
        Path: {
          type: "STRING",
          description: "The absolute path of the file to read.",
        },
        StartLine: {
          type: "INTEGER",
          description: "Start line to read (inclusive). Omit to read from the beginning of the file.",
        },
      },
      required: ["Path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create a new file with the given contents, or append to an existing file when Append is true. Parent directories are created automatically. Fails if the file already exists unless Overwrite or Append is true. When creating an artifact, always provide ArtifactMetadata. When creating non-artifact files, do not provide it.",
    parameters: {
      type: "OBJECT",
      properties: {
        Append: {
          type: "BOOLEAN",
          description:
            "Whether to append Content to the end of the file (creating the file if it does not exist). Cannot be combined with Overwrite=true.",
        },
        ArtifactMetadata: {
          type: "OBJECT",
          description:
            "Metadata that defines artifact properties. ONLY provide when creating an artifact file in the artifact directory. Omit this field when creating non-artifact files.",
          properties: ARTIFACT_METADATA_PROPERTIES,
          required: [...ARTIFACT_METADATA_REQUIRED],
        },
        Content: {
          type: "STRING",
          description: "The full contents to write to the file.",
        },
        Overwrite: {
          type: "BOOLEAN",
          description: "Whether to overwrite an existing file, replacing its entire contents.",
        },
        Path: {
          type: "STRING",
          description: "The absolute path of the file to create.",
          minLength: "1",
        },
      },
      required: ["Path", "Content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Use this tool to edit an existing file. Follow these rules:\n1. Use this tool for a single contiguous block of edits. To edit multiple non-adjacent regions, make separate calls.\n2. Target must exactly match existing file text, including whitespace. Replacement must be a complete drop-in replacement for the Target.\n3. If Target appears multiple times in the file, every occurrence is replaced.",
    parameters: {
      type: "OBJECT",
      properties: {
        ArtifactMetadata: {
          type: "OBJECT",
          description:
            "Metadata updates if updating an artifact file in the artifact directory. Omit this field when editing non-artifact files. Should be updated if the content is changing meaningfully.",
          properties: ARTIFACT_METADATA_PROPERTIES,
          required: [...ARTIFACT_METADATA_REQUIRED],
        },
        Path: {
          type: "STRING",
          description: "The absolute path of the file to modify.",
          minLength: "1",
        },
        Replacement: {
          type: "STRING",
          description: "The content to replace the target with. Leave empty to delete the target.",
        },
        Target: {
          type: "STRING",
          description:
            "The exact string to be replaced. This must be the exact character-sequence to be replaced, including whitespace. Be very careful to include any leading whitespace otherwise this will not work at all. If the string appears multiple times in the file, every occurrence is replaced.",
          minLength: "1",
        },
      },
      required: ["Path", "Target", "Replacement"],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a command in the workspace. Operating System: mac. Shell: zsh. Each command runs in a new session (working directory changes and environment variables do not persist across calls). Commands that do not finish within the specified wait time continue running in the background as tasks; the system will notify you when they finish, so do not poll their status or set timers to check on them.",
    parameters: {
      type: "OBJECT",
      properties: {
        CommandLine: {
          type: "STRING",
          description: "The exact command line string to execute.",
        },
        IsDaemon: {
          type: "BOOLEAN",
          description:
            "Set to true for long-running support processes that are meant to keep running in the background indefinitely and are not expected to finish on their own (e.g., dev servers, file watchers, tunnels). Leave false (the default) for normal commands that are expected to terminate.",
        },
        WaitMsBeforeAsync: {
          type: "INTEGER",
          description:
            "Milliseconds to wait for the command to finish before backgrounding it (500 to 10000). Set to a larger value (e.g. 5000-10000) for commands expected to finish synchronously; set to 500 for commands intended to run in the background.",
        },
        toolSummary: {
          type: "STRING",
          description:
            "Brief 2-5 word noun phrase describing the command task. Capitalize like a sentence. Some examples: 'Git status check', 'Unit test execution', 'Package build', 'Dev server startup'.",
        },
      },
      required: ["CommandLine", "toolSummary", "WaitMsBeforeAsync"],
    },
  },
  {
    name: "manage_task",
    description:
      "Manage the background tasks of this conversation: 'list' the running tasks, check a task's 'status' and recent log output, 'send_input' to a running task, or 'kill' one. Refer to tasks by the TaskId that 'list' reports; keep task references human-readable when talking to the user.",
    parameters: {
      type: "OBJECT",
      properties: {
        Action: {
          type: "STRING",
          description:
            "'list' reports the running tasks; the other actions operate on the task named in TaskId.",
          enum: ["list", "kill", "status", "send_input"],
        },
        Input: {
          type: "STRING",
          description: "Input to deliver to the task. Required for 'send_input'.",
        },
        TaskId: {
          type: "STRING",
          description: "Task to manage, as reported by 'list'. Required for 'kill', 'status' and 'send_input'.",
        },
      },
      required: ["Action"],
    },
  },
];

const DECL_BY_NAME = new Map<string, AgyFunctionDeclaration>(
  AGY_BUILTIN_DECLARATIONS.map((d) => [d.name, d]),
);

/**
 * Formats a Date as local RFC3339 with seconds precision (`Z` when UTC offset is 0),
 * matching `agy`'s `Created At` / `Completed At` header lines.
 */
export function formatAgyTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const offMinutes = -d.getTimezoneOffset();
  const body =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (offMinutes === 0) return `${body}Z`;
  const sign = offMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offMinutes);
  return `${body}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Formats a Date as UTC RFC3339 with seconds precision (`YYYY-MM-DDTHH:MM:SSZ`),
 * matching `agy`'s `startTime` and `<SYSTEM_MESSAGE>` timestamps.
 */
export function formatAgyUtcTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class AgyToolValidationError extends Error {
  constructor(bullets: string[]) {
    super(`Encountered error in tool validation: invalid arguments:\n${bullets.map((b) => `- ${b}`).join("\n")}`);
    this.name = "AgyToolValidationError";
  }
}

export class AgyToolExecutionError extends Error {
  constructor(detail: string) {
    super(`Encountered error in tool execution: ${detail}`);
    this.name = "AgyToolExecutionError";
  }
}

function jsonTypeLabel(val: unknown): string {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}

function validateObjectAgainstSchema(
  obj: Record<string, unknown>,
  schema: Record<string, unknown>,
  pathPrefix: string,
  bullets: string[],
): void {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];

  const missing = required.filter((key) => !(key in obj) || obj[key] === undefined);
  if (missing.length === 1) {
    const msg = `missing property '${missing[0]}'`;
    bullets.push(pathPrefix ? `at '${pathPrefix}': ${msg}` : msg);
  } else if (missing.length > 1) {
    const msg = `missing properties ${missing.map((k) => `'${k}'`).join(", ")}`;
    bullets.push(pathPrefix ? `at '${pathPrefix}': ${msg}` : msg);
  }

  const extras = Object.keys(obj).filter((key) => obj[key] !== undefined && !(key in properties));
  if (extras.length > 0) {
    const msg = `additional properties ${extras.map((k) => `'${k}'`).join(", ")} not allowed`;
    bullets.push(pathPrefix ? `at '${pathPrefix}': ${msg}` : msg);
  }

  for (const [propKey, propSchema] of Object.entries(properties)) {
    if (!(propKey in obj) || obj[propKey] === undefined) continue;
    const val = obj[propKey];
    const ptr = `${pathPrefix}/${propKey}`;
    const wantType = String(propSchema.type ?? "").toLowerCase();

    if (wantType === "string") {
      if (typeof val !== "string") {
        bullets.push(`at '${ptr}': got ${jsonTypeLabel(val)}, want string`);
        continue;
      }
      const minLenRaw = propSchema.minLength;
      const minLen = typeof minLenRaw === "number" ? minLenRaw : typeof minLenRaw === "string" ? Number(minLenRaw) : 0;
      if (minLen > 0 && [...val].length < minLen) {
        bullets.push(`at '${ptr}': minLength: got ${[...val].length}, want ${minLen}`);
        continue;
      }
      const allowedEnum = propSchema.enum as string[] | undefined;
      if (Array.isArray(allowedEnum) && !allowedEnum.includes(val)) {
        bullets.push(`at '${ptr}': value must be one of ${allowedEnum.map((e) => `'${e}'`).join(", ")}`);
      }
    } else if (wantType === "integer") {
      if (typeof val !== "number" || !Number.isInteger(val)) {
        bullets.push(`at '${ptr}': got ${jsonTypeLabel(val)}, want integer`);
      }
    } else if (wantType === "boolean") {
      if (typeof val !== "boolean") {
        bullets.push(`at '${ptr}': got ${jsonTypeLabel(val)}, want boolean`);
      }
    } else if (wantType === "object") {
      if (!val || typeof val !== "object" || Array.isArray(val)) {
        bullets.push(`at '${ptr}': got ${jsonTypeLabel(val)}, want object`);
        continue;
      }
      validateObjectAgainstSchema(val as Record<string, unknown>, propSchema, ptr, bullets);
    }
  }
}

/**
 * Deterministically validates tool arguments against `agy 1.5.10`'s schema rules.
 */
export function validateAgyToolArgs(
  toolName: string,
  rawArgs: Record<string, unknown>,
  customDecl?: AgyFunctionDeclaration,
): void {
  const decl = customDecl ?? DECL_BY_NAME.get(toolName);
  const schema = (decl?.parameters ?? decl?.parametersJsonSchema) as Record<string, unknown> | undefined;
  if (!schema) return;

  const bullets: string[] = [];
  validateObjectAgainstSchema(rawArgs, schema, "", bullets);
  if (bullets.length > 0) {
    throw new AgyToolValidationError(bullets);
  }
}

/**
 * 自建扩展工具（非 agy 原生）：按路径拉取适用的 AGENTS.md / CLAUDE.md 与 skills。
 * pull 模型 —— 只在被调用时读取，不塞进启动期 instructions。
 */
export const USER_RULES_TOOL_NAME = "userRules";

export const USER_RULES_DECLARATION: AgyFunctionDeclaration = {
  name: USER_RULES_TOOL_NAME,
  description:
    "List the AGENTS.md / CLAUDE.md rule files and local skills that apply to a path, walking up from it to the home directory. Call this before writing files or running commands in an unfamiliar directory, then read the listed files with read_file when you need their full text.",
  parameters: {
    type: "OBJECT",
    properties: {
      Path: {
        type: "STRING",
        description:
          "Absolute path of the file or directory to inspect. Omit to get user-level rules only.",
      },
      Scope: {
        type: "STRING",
        enum: ["auto", "user", "project", "all"],
        description:
          "auto (default) keeps the whole walk-up chain; user limits to home-level rules; project drops home-level ones; all is the same as auto.",
      },
      IncludeSkills: {
        type: "BOOLEAN",
        description: "Include SKILL.md entries found in .agents/skills and .claude/skills (default true).",
      },
      Detail: {
        type: "STRING",
        enum: ["list", "full"],
        description:
          "list (default) returns names and truncated descriptions; full also inlines the rule file contents.",
      },
      Query: {
        type: "STRING",
        description: "Optional keywords; matching skills are ranked first.",
      },
    },
  },
};
