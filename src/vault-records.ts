/**
 * Guards the vault records written before the package swap.
 *
 * The vendored 0.2.0 build keyed records as `vault:<workspaceId>:<key>`. The published
 * package uses a JSON tuple, `["vault:","<workspaceId>","<key>"]`. Nothing migrates the old
 * shape, because Aboiteau is pre-alpha and holds no credentials - so an old key is evidence
 * that something is wrong, not data to convert.
 *
 * Kept pure so a test can exercise it: constructing a Durable Object with a fake context is
 * not possible (the base class validates its arguments), and the check is the part worth
 * testing, not the constructor that calls it.
 */
const NEW_FORMAT_PREFIX = "[";

/** The keys that predate the package swap. */
export function staleVaultKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => !key.startsWith(NEW_FORMAT_PREFIX));
}

/**
 * Throws if any record predates the swap.
 *
 * The message names the count and one key so the operator can find the records, and never
 * a value: the whole point of the store is that its payload is ciphertext nobody should be
 * reading while diagnosing.
 */
export function assertNoStaleVaultRecords(keys: Iterable<string>): void {
  const stale = staleVaultKeys(keys);
  if (stale.length === 0) return;
  throw new Error(
    `Found ${stale.length} vault record(s) that predate the package swap; sample key: ${stale[0]}. ` +
      "Delete them or re-enter the credential.",
  );
}
