/** Parse a Retry-After header into seconds, bounded. */
export function retryAfterSeconds(value: string | null, max = 30): number {
  const text = value?.trim()
  if (!text) return 1
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0) return 1
  return Math.min(parsed, max)
}
