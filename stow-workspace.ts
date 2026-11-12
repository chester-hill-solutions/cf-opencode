import { isAbsolute, resolve } from "node:path"

export type WorkspaceIdentity = Readonly<{
  version: 1
  workspace_id: string
  root: string
  working_directory: string
  registry_dir: string
  bucket: string
}>

export type WorkspaceReadiness = Readonly<WorkspaceIdentity & {
  endpoint: string
  region: string
  access_key_id: string
  secret_access_key: string
}>

export type ExpectedWorkspace = Readonly<{
  root: string
  registryDir: string
  bucket: string
}>

export class WorkspaceContractError extends Error {
  constructor(message: "invalid workspace identity" | "invalid workspace readiness") {
    super(message)
    this.name = "WorkspaceContractError"
  }
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function canonicalAbsolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value
}

function workspaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function expectedPaths(expected: ExpectedWorkspace): { root: string; registryDir: string } {
  return { root: resolve(expected.root), registryDir: resolve(expected.registryDir) }
}

/** Validate and return only the durable, non-secret workspace identity fields. */
export function parseWorkspaceIdentity(
  value: unknown,
  expected: ExpectedWorkspace,
): WorkspaceIdentity {
  const input = object(value)
  const paths = expectedPaths(expected)
  if (
    !input || input.version !== 1 || !workspaceId(input.workspace_id) ||
    !canonicalAbsolute(input.root) || input.root !== paths.root ||
    !canonicalAbsolute(input.registry_dir) || input.registry_dir !== paths.registryDir ||
    input.bucket !== expected.bucket || typeof input.bucket !== "string" || !input.bucket ||
    (input.working_directory !== input.root && input.working_directory !== ".")
  ) {
    throw new WorkspaceContractError("invalid workspace identity")
  }

  return Object.freeze({
    version: 1,
    workspace_id: input.workspace_id,
    root: paths.root,
    working_directory: paths.root,
    registry_dir: paths.registryDir,
    bucket: expected.bucket,
  })
}

function loopbackEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false
  // Match the authority directly so an explicit port is required even when
  // URL would normalize a default port away. No credentials or URL suffixes.
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})(\/?)$/.exec(value)
  if (!match) return false
  const port = Number(match[2])
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function safeCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Validate fresh serve credentials against the durable identity before use. */
export function parseWorkspaceReadiness(
  value: unknown,
  identity: WorkspaceIdentity,
): WorkspaceReadiness {
  const input = object(value)
  if (
    !input || input.version !== identity.version ||
    input.workspace_id !== identity.workspace_id || input.root !== identity.root ||
    (input.working_directory !== identity.root && input.working_directory !== ".") ||
    input.registry_dir !== identity.registry_dir || input.bucket !== identity.bucket ||
    !loopbackEndpoint(input.endpoint) || !safeCredential(input.region) ||
    !safeCredential(input.access_key_id) || !safeCredential(input.secret_access_key)
  ) {
    throw new WorkspaceContractError("invalid workspace readiness")
  }

  return Object.freeze({
    ...identity,
    endpoint: input.endpoint,
    region: input.region,
    access_key_id: input.access_key_id,
    secret_access_key: input.secret_access_key,
  })
}
