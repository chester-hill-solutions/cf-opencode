/**
 * Archive encryption policy.
 *
 * Workspace and account-state archives contain provider credentials. Storing
 * them unencrypted in R2 must be a deliberate choice, never the silent result
 * of a missing secret: absence of `VAULT_MASTER_KEY` fails closed unless the
 * operator explicitly opts in with `ALLOW_PLAINTEXT_ARCHIVES=1`.
 */

export interface ArchivePolicyEnv {
  VAULT_MASTER_KEY?: string
  ALLOW_PLAINTEXT_ARCHIVES?: string
}

/** True only when the deployment has explicitly opted out of encryption. */
export function plaintextArchivesAllowed(env: ArchivePolicyEnv): boolean {
  return !env.VAULT_MASTER_KEY && env.ALLOW_PLAINTEXT_ARCHIVES === "1"
}

/** True when a checkpoint or account seed must not be written without a key. */
export function encryptionRequired(env: ArchivePolicyEnv): boolean {
  return !env.VAULT_MASTER_KEY && !plaintextArchivesAllowed(env)
}
