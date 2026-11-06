export interface VaultEntry {
    id: string;
    workspaceId: string;
    key: string;
    encryptedValue: string;
    createdAt: string;
    updatedAt: string;
}
export interface VaultStore {
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
    delete(workspaceId: string, key: string): Promise<void>;
    list(workspaceId: string): Promise<string[]>;
}
export declare class Vault {
    private store;
    private masterKeyHex;
    constructor(store: VaultStore, masterKeyHex: string);
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
    delete(workspaceId: string, key: string): Promise<void>;
    list(workspaceId: string): Promise<string[]>;
}
export declare function createInMemoryVaultStore(): VaultStore;
/**
 * Minimal subset of Cloudflare Durable Object storage (and the similar KeyValue
 * surfaces) this store needs. Deliberately structural so Workers code can pass
 * `ctx.storage` directly without an adapter.
 */
export interface VaultKeyValueStorage {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(options: {
        prefix: string;
    }): Promise<Map<string, T>>;
}
/**
 * Store vault entries in a key/value backend such as Durable Object storage.
 * Entries are namespaced by workspace id so one account can hold several
 * workspaces without collisions.
 */
export declare function createKeyValueVaultStore(storage: VaultKeyValueStorage, prefix?: string): VaultStore;
