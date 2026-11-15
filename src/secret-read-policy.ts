/**
 * Which stored credentials the Settings DO may decrypt for a caller.
 *
 * The DO's `fetch` handler is not a public route — it is only reachable through
 * the `SETTINGS` binding — but until this list existed it decrypted whatever key
 * name the caller sent. Every conversation holds that stub, so "can read the
 * GitHub token" and "can read any credential the harness will ever store" were
 * the same permission. They are not the same permission.
 *
 * The list is deliberately tiny and explicit: a new reader is a reviewable edit
 * here, not an arbitrary key string at a call site. Provider credentials stay
 * unreadable by name until there is a use path that does not return the value.
 */
import { GITHUB_TOKEN_KEY } from "./vault"

/** Credential names the Settings DO will decrypt. Nothing else. */
export const READABLE_SECRET_KEYS: ReadonlySet<string> = new Set([GITHUB_TOKEN_KEY])

/** Longest key name the harness will consider. Names are hand-written, not generated. */
const MAX_KEY_LENGTH = 256

export type SecretReadDecision =
  | { allowed: true; key: string }
  | { allowed: false; reason: "invalid-key" | "not-readable" }

/**
 * Decide whether a key may be decrypted, without touching the vault.
 *
 * Callers must run this before `vaultOrError()` so a refused name cannot be
 * turned into a vault error that distinguishes "unavailable" from "exists".
 */
export function decideSecretRead(key: unknown): SecretReadDecision {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return { allowed: false, reason: "invalid-key" }
  }
  return READABLE_SECRET_KEYS.has(key) ? { allowed: true, key } : { allowed: false, reason: "not-readable" }
}
