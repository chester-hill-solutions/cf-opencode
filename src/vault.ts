/**
 * Encrypted credential storage for the harness.
 *
 * Uses the CHS vault package with a Durable Object storage backend, so provider
 * and GitHub credentials are encrypted at rest and never appear in settings
 * responses. Keys are namespaced by workspace id, which keeps the door open for
 * per-tenant onboarding later.
 */

import {
  Vault,
  createKeyValueVaultStore,
  type VaultKeyValueStorage,
} from "@chester-hill-solutions/vault/core"

/** Only the environment fields credentials storage needs. */
export interface VaultEnv {
  VAULT_MASTER_KEY?: string
  WORKSPACE_ID?: string
}

export const GITHUB_TOKEN_KEY = "github.token"
export const GITHUB_LOGIN_KEY = "github.login"

/** Tenant key. Single-tenant today; a real account id when onboarding is multi-tenant. */
export function workspaceID(env: VaultEnv): string {
  return env.WORKSPACE_ID ?? "default"
}

export function accountVault(env: VaultEnv, storage: VaultKeyValueStorage): Vault | undefined {
  const key = env.VAULT_MASTER_KEY
  if (!key) return undefined
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error("VAULT_MASTER_KEY must be 64 hex characters (32 bytes)")
  }
  return new Vault(createKeyValueVaultStore(storage), key)
}
