/**
 * Reading one stored credential, and saying so when it cannot be read.
 *
 * Lives outside `conversation.ts` (which sits at its size budget) and outside
 * the vault route itself, because the caller is the one that has to decide what
 * a missing credential means. A read that fails silently is expensive: the
 * workspace clone simply runs unauthenticated and the only symptom is Git
 * asking for a username.
 */
import type { Env } from "./env"
import { logEvent } from "./log"

/** Decrypt one stored credential through the Settings DO. */
export async function readCredential(
  env: Pick<Env, "SETTINGS">,
  key: string,
): Promise<string | undefined> {
  try {
    const res = await env.SETTINGS.getByName("global").fetch("https://settings/secrets/get", {
      method: "POST",
      body: JSON.stringify({ key }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      logEvent("credential.read.failed", {
        key,
        status: res.status,
        ...(body.error ? { reason: body.error } : {}),
      })
      return undefined
    }
    const body = (await res.json()) as { value?: string | null }
    return body.value ?? undefined
  } catch (error) {
    logEvent("credential.read.failed", {
      key,
      reason: error instanceof Error ? error.message : "unavailable",
    })
    return undefined
  }
}
