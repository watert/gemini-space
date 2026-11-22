import * as z from "zod/v4";

export const DEVSPACE_CONFIG_VERSION = 1 as const;

export const DEVSPACE_CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json";

export const DEFAULT_AGY_EXPOSED_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "manage_task",
] as const;

const serverConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7676),
  publicBaseUrl: z.string().url().nullable().default(null),
  allowedHosts: z.array(z.string().trim().min(1)).default([]),
  trustProxy: z.union([z.boolean(), z.literal("loopback")]).default(false),
}).passthrough().prefault({});

const storageConfigSchema = z.object({
  stateDir: z.string().trim().min(1).default("~/.local/share/devspace"),
}).passthrough().prefault({});

const agyConfigSchema = z.object({
  bin: z.string().trim().min(1).optional(),
  workspace: z.string().trim().min(1).default("~"),
  agyHome: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).default("gemini-3.1-pro-preview"),
  wireProtocol: z.enum(["genai", "openai"]).default("genai"),
  holdMs: z.number().int().min(1_000).max(58_000).default(12_000),
  callTimeoutMs: z.number().int().min(5_000).max(120_000).default(50_000),
  maxTurnsPerSession: z.number().int().min(5).max(1_000).default(80),
  sessionIdleTtlMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(30 * 60_000),
  exposedTools: z.array(z.string().trim().min(1)).min(1).default([...DEFAULT_AGY_EXPOSED_TOOLS]),
}).passthrough().prefault({});

const skillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string().trim().min(1)).default([]),
}).passthrough().prefault({});

const codeModeConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).passthrough().prefault({});

const uiConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).passthrough().prefault({});

const activityConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxCalls: z.number().int().min(50).max(10_000).default(500),
}).passthrough().prefault({});

const loggingConfigSchema = z.object({
  level: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  requests: z.boolean().default(true),
  assets: z.boolean().default(false),
  toolCalls: z.boolean().default(true),
  shellCommands: z.boolean().default(false),
}).passthrough().prefault({});

const oauthConfigSchema = z.object({
  accessTokenTtlSeconds: z.number().int().positive().default(60 * 60),
  refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  refreshTokenGraceSeconds: z.number().int().min(0).max(600).default(300),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["devspace"]),
  allowedResourceUrls: z.array(z.string().trim().url().refine((value) => {
    const url = URL.parse(value);
    return url !== null && (url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }, "Resource URLs must use HTTPS, or HTTP on localhost, 127.0.0.1, or [::1]"))
    .default([]),
  allowedRedirectHosts: z.array(z.string().trim().min(1)).min(1).default([
    "gemini.google.com",
    "oauth-redirect.googleusercontent.com",
    "oauth-redirect-sandbox.googleusercontent.com",
    "oauth-redirect-test.googleusercontent.com",
    "chatgpt.com",
    "localhost",
    "127.0.0.1",
  ]),
}).passthrough().prefault({});

/**
 * `.passthrough()` allows existing `~/.devspace/config.jsonc` files written by
 * older Synrex/DevSpace versions (`node`, `cluster`, `workspaces`, `tools`, etc.)
 * to load without breaking.
 */
export const devspaceConfigSchema = z.object({
  $schema: z.string().url().default(DEVSPACE_CONFIG_SCHEMA_URL),
  configVersion: z.literal(DEVSPACE_CONFIG_VERSION).default(DEVSPACE_CONFIG_VERSION),
  server: serverConfigSchema,
  storage: storageConfigSchema,
  agy: agyConfigSchema,
  skills: skillsConfigSchema,
  codeMode: codeModeConfigSchema,
  ui: uiConfigSchema,
  activity: activityConfigSchema,
  logging: loggingConfigSchema,
  oauth: oauthConfigSchema,
}).passthrough();

export type DevspaceConfig = z.output<typeof devspaceConfigSchema>;
export type DevspaceConfigInput = z.input<typeof devspaceConfigSchema>;

export function defaultDevspaceConfig(): DevspaceConfig {
  return devspaceConfigSchema.parse({ configVersion: DEVSPACE_CONFIG_VERSION });
}
