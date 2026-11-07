/**
 * Archive member validation.
 *
 * Restore archives come from R2 and are therefore attacker-controlled if the
 * bucket is ever compromised. `tar` will happily write `../../etc/passwd` or an
 * absolute path, so every archive is listed and checked before extraction.
 */

/** True when no member can escape the extraction root. */
export function safeArchiveMembers(list: string): boolean {
  for (const raw of list.split("\n")) {
    const member = raw.replace(/\r$/, "")
    if (!member) continue
    if (member.startsWith("/") || member.startsWith("\\")) return false
    if (/^[a-zA-Z]:[\\/]/.test(member)) return false
    if (member.split(/[\\/]/).includes("..")) return false
  }
  return true
}

export function assertSafeArchiveMembers(list: string): void {
  if (!safeArchiveMembers(list)) {
    throw new Error("archive contains a member that escapes the extraction root")
  }
}
