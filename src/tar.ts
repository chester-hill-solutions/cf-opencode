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

/**
 * True when a link target is relative and cannot climb out of the extraction
 * root. Hard-link targets are stored separately from member names, so the
 * member-name check alone does not cover them.
 */
export function safeRelativeLink(target: string): boolean {
  if (!target) return false
  if (target.startsWith("/") || target.startsWith("\\")) return false
  if (/^[a-zA-Z]:[\\/]/.test(target)) return false
  return !target.split(/[\\/]/).includes("..")
}

/**
 * True when a resolved link target stays inside the extraction root. Used for
 * workspace symlinks: a link to harness state would let the agent read provider
 * credentials through a path that never names the state root.
 */
export function linkStaysInside(root: string, target: string): boolean {
  const base = root.replace(/\/+$/, "")
  return target === base || target.startsWith(`${base}/`)
}
