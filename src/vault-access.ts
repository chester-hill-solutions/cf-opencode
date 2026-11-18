/**
 * Resolving the workspace vault, and saying why when it cannot be resolved.
 *
 * Extracted from `Settings` because that file sits at its size budget: a guard that refuses
 * pre-swap vault records is worth nine lines, and the honest way to afford them is to move
 * something cohesive out rather than to trim the comments that explain the class.
 */
import type { Vault, VaultKeyValueStorage } from "@chester-hill-solutions/vault/core"

import type { Env } from "./env"
import { accountVault } from "./vault"

/**
 * The workspace vault, or the `Response` that explains why it is unavailable.
 *
 * A missing master key is a 503 the operator can fix; anything thrown while constructing the
 * vault is a 500 carrying the vault's own message, which never contains a secret value.
 */
export function vaultOrErrorResponse(
  env: Env,
  storage: VaultKeyValueStorage,
): Vault | Response {
  try {
    const vault = accountVault(env, storage)
    if (!vault) {
      return Response.json(
        { error: "VAULT_MASTER_KEY is not configured; set it before connecting accounts" },
        { status: 503 },
      )
    }
    return vault
  } catch (error) {
    const message = error instanceof Error ? error.message : "vault unavailable"
    return Response.json({ error: message }, { status: 500 })
  }
}

/**
 * A vault that exists but cannot read its own records.
 *
 * The 0.5 package refuses ciphertext from the pre-v2 format instead of
 * returning garbage, and that throw used to escape the Durable Object: the
 * status route answered 1101 and a credential read silently returned nothing.
 * Name the reason so the operator can replace the record.
 */
export function vaultUnreadableResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "vault unavailable"
  return Response.json({ error: message, code: "VAULT_UNREADABLE" }, { status: 500 })
}

/** A workspace's credential names, or why the records cannot be read. */
export async function vaultKeysResponse(vault: Vault, workspace: string): Promise<Response> {
  try {
    return Response.json({ keys: await vault.listSecrets(workspace) })
  } catch (error) {
    return vaultUnreadableResponse(error)
  }
}

/** One decrypted credential by name, or why it cannot be read. */
export async function vaultSecretResponse(
  vault: Vault,
  workspace: string,
  key: string,
): Promise<Response> {
  try {
    return Response.json({ value: await vault.getSecret(workspace, key) })
  } catch (error) {
    return vaultUnreadableResponse(error)
  }
}
