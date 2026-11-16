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
