import { VaultKeyError, decrypt, deriveWorkspaceKey, encrypt, keyFingerprint, parseCiphertext, parseMasterKey, } from "./encryption.js";
const DEFAULT_KEY_ID = "default";
function normalizeKeyring(masterKey) {
    const candidate = typeof masterKey === "string"
        ? { activeKeyId: DEFAULT_KEY_ID, keys: { [DEFAULT_KEY_ID]: masterKey } }
        : { activeKeyId: masterKey?.activeKeyId, keys: masterKey?.keys };
    if (!candidate.activeKeyId) {
        throw new VaultKeyError("Vault keyring needs an activeKeyId.");
    }
    if (!candidate.keys || typeof candidate.keys !== "object") {
        throw new VaultKeyError("Vault keyring needs a keys map of master keys.");
    }
    const keys = candidate.keys;
    for (const [id, hex] of Object.entries(keys)) {
        try {
            parseMasterKey(hex);
        }
        catch (error) {
            throw new VaultKeyError(`Master key "${id}" is invalid: ${error.message}`);
        }
    }
    if (!keys[candidate.activeKeyId]) {
        throw new VaultKeyError(`Vault keyring has no master key for the active key id "${candidate.activeKeyId}".`);
    }
    return { activeKeyId: candidate.activeKeyId, keys: { ...keys } };
}
/**
 * Per-workspace encrypted credential storage.
 *
 * Each workspace's secrets are encrypted with a key derived from the master
 * key and the workspace id, so one workspace's secrets cannot be read with
 * another workspace's key, and changing the master key invalidates every
 * secret written under the old one.
 */
export class Vault {
    store;
    keyring;
    index = null;
    constructor(store, masterKey) {
        this.store = store;
        this.keyring = normalizeKeyring(masterKey);
    }
    /** Id of the master key new secrets are encrypted with. */
    get activeKeyId() {
        return this.keyring.activeKeyId;
    }
    async getSecret(workspaceId, key) {
        const stored = await this.store.get(workspaceId, key);
        if (!stored)
            return null;
        const { keyRef } = parseCiphertext(stored);
        return decrypt(stored, await this.workspaceKey(workspaceId, keyRef));
    }
    async setSecret(workspaceId, key, value) {
        const activeKeyId = this.keyring.activeKeyId;
        const activeRef = await this.refFor(activeKeyId);
        const encrypted = await encrypt(value, await this.workspaceKey(workspaceId, activeRef), activeRef);
        await this.store.set(workspaceId, key, encrypted);
    }
    async deleteSecret(workspaceId, key) {
        await this.store.delete(workspaceId, key);
    }
    async listSecrets(workspaceId) {
        const metadata = await this.store.listMetadata(workspaceId);
        return metadata.map(entry => entry.key);
    }
    /** Describes the secrets a workspace holds, without revealing any of them. */
    async listSecretMetadata(workspaceId) {
        return this.store.listMetadata(workspaceId);
    }
    /**
     * Re-encrypts one secret under the active master key.
     *
     * Returns false when the secret is missing or already under the active key.
     */
    async reencryptSecret(workspaceId, key) {
        const stored = await this.store.get(workspaceId, key);
        if (!stored)
            return false;
        const { keyRef } = parseCiphertext(stored);
        const activeRef = await this.refFor(this.keyring.activeKeyId);
        if (keyRef === activeRef)
            return false;
        const plaintext = await decrypt(stored, await this.workspaceKey(workspaceId, keyRef));
        await this.store.set(workspaceId, key, await encrypt(plaintext, await this.workspaceKey(workspaceId, activeRef), activeRef));
        return true;
    }
    /** Re-encrypts every secret held for a workspace. Returns how many changed. */
    async reencryptWorkspace(workspaceId) {
        const keys = await this.listSecrets(workspaceId);
        let migrated = 0;
        for (const key of keys) {
            if (await this.reencryptSecret(workspaceId, key))
                migrated++;
        }
        return migrated;
    }
    async workspaceKey(workspaceId, keyRef) {
        const hex = (await this.keyIndex()).byRef.get(keyRef);
        if (!hex) {
            throw new VaultKeyError(`Secret was encrypted with master key ${keyRef}, which is not in the keyring. Add that master key to read it.`);
        }
        return deriveWorkspaceKey(hex, workspaceId);
    }
    /** The reference a secret written with the given key id carries. */
    async refFor(keyId) {
        const ref = (await this.keyIndex()).byId.get(keyId);
        if (!ref) {
            throw new VaultKeyError(`Vault keyring has no master key for "${keyId}".`);
        }
        return ref;
    }
    /**
     * The keyring's keys, indexed both by the id the operator gave them and by
     * the reference a secret carries. Built once, on first use.
     */
    async keyIndex() {
        if (!this.index) {
            const byId = new Map();
            const byRef = new Map();
            for (const [id, hex] of Object.entries(this.keyring.keys)) {
                const ref = await keyFingerprint(hex);
                byId.set(id, ref);
                byRef.set(ref, hex);
            }
            this.index = { byId, byRef };
        }
        return this.index;
    }
}
export function createInMemoryVaultStore() {
    const store = new Map();
    return {
        async get(workspaceId, key) {
            return store.get(workspaceId)?.get(key)?.value ?? null;
        },
        async set(workspaceId, key, value) {
            if (!store.has(workspaceId))
                store.set(workspaceId, new Map());
            const secrets = store.get(workspaceId);
            const existing = secrets.get(key);
            const now = new Date().toISOString();
            secrets.set(key, {
                value,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            });
        },
        async delete(workspaceId, key) {
            store.get(workspaceId)?.delete(key);
        },
        async listMetadata(workspaceId) {
            return Array.from(store.get(workspaceId)?.entries() ?? []).map(([key, entry]) => ({
                key,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
            }));
        },
    };
}
