/**
 * Driver-free entry point: the vault core plus a key/value store adapter.
 *
 * The upstream package's root entry also exports the Postgres store, which
 * pulls drizzle into a Worker bundle. This entry keeps the Worker build to the
 * encryption core and the storage adapter it actually uses.
 */
export { Vault, createInMemoryVaultStore } from "./vault.js";
export { encrypt, decrypt, deriveWorkspaceKey, keyFingerprint, parseCiphertext, parseMasterKey, VaultKeyError, CIPHERTEXT_VERSION, } from "./encryption.js";
/**
 * Store ciphertext in a key/value backend, namespaced by workspace id.
 *
 * Values are wrapped with their timestamps so `listSecretMetadata` can describe
 * a secret without decrypting it. A legacy raw string is still returned by
 * `get`; the vault refuses pre-v2 formats with an actionable error.
 */
export function createKeyValueVaultStore(storage, prefix = "vault:") {
    const record = (workspaceId, key) => `${prefix}${workspaceId}:${key}`;
    const workspacePrefix = (workspaceId) => `${prefix}${workspaceId}:`;
    return {
        async get(workspaceId, key) {
            const stored = await storage.get(record(workspaceId, key));
            if (!stored)
                return null;
            return typeof stored === "string" ? stored : stored.value;
        },
        async set(workspaceId, key, value) {
            const now = new Date().toISOString();
            const existing = await storage.get(record(workspaceId, key));
            await storage.put(record(workspaceId, key), {
                value,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            });
        },
        async delete(workspaceId, key) {
            await storage.delete(record(workspaceId, key));
        },
        async listMetadata(workspaceId) {
            const entries = await storage.list({
                prefix: workspacePrefix(workspaceId),
            });
            const base = workspacePrefix(workspaceId).length;
            return Array.from(entries.entries()).map(([name, stored]) => {
                const key = name.slice(base);
                if (typeof stored === "string") {
                    return { key, createdAt: "", updatedAt: "" };
                }
                return { key, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
            });
        },
    };
}
