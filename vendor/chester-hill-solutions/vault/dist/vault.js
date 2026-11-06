import { encrypt, decrypt, deriveWorkspaceKey } from "./encryption.js";
export class Vault {
    store;
    masterKeyHex;
    constructor(store, masterKeyHex) {
        this.store = store;
        this.masterKeyHex = masterKeyHex;
    }
    async get(workspaceId, key) {
        const encrypted = await this.store.get(workspaceId, key);
        if (!encrypted)
            return null;
        const workspaceKey = await deriveWorkspaceKey(this.masterKeyHex, workspaceId);
        return decrypt(encrypted, workspaceKey);
    }
    async set(workspaceId, key, value) {
        const workspaceKey = await deriveWorkspaceKey(this.masterKeyHex, workspaceId);
        const encrypted = await encrypt(value, workspaceKey);
        await this.store.set(workspaceId, key, encrypted);
    }
    async delete(workspaceId, key) {
        await this.store.delete(workspaceId, key);
    }
    async list(workspaceId) {
        return this.store.list(workspaceId);
    }
}
export function createInMemoryVaultStore() {
    const store = new Map();
    return {
        async get(workspaceId, key) {
            return store.get(workspaceId)?.get(key) ?? null;
        },
        async set(workspaceId, key, value) {
            if (!store.has(workspaceId))
                store.set(workspaceId, new Map());
            store.get(workspaceId).set(key, value);
        },
        async delete(workspaceId, key) {
            store.get(workspaceId)?.delete(key);
        },
        async list(workspaceId) {
            return Array.from(store.get(workspaceId)?.keys() ?? []);
        },
    };
}
/**
 * Store vault entries in a key/value backend such as Durable Object storage.
 * Entries are namespaced by workspace id so one account can hold several
 * workspaces without collisions.
 */
export function createKeyValueVaultStore(storage, prefix = "vault:") {
    const record = (workspaceId, key) => `${prefix}${workspaceId}:${key}`;
    const workspacePrefix = (workspaceId) => `${prefix}${workspaceId}:`;
    return {
        async get(workspaceId, key) {
            const value = await storage.get(record(workspaceId, key));
            return value ?? null;
        },
        async set(workspaceId, key, value) {
            await storage.put(record(workspaceId, key), value);
        },
        async delete(workspaceId, key) {
            await storage.delete(record(workspaceId, key));
        },
        async list(workspaceId) {
            const entries = await storage.list({ prefix: workspacePrefix(workspaceId) });
            const base = workspacePrefix(workspaceId).length;
            return Array.from(entries.keys()).map((name) => name.slice(base));
        },
    };
}
