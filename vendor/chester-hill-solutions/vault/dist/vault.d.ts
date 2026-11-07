export interface VaultEntry {
    id: string;
    workspaceId: string;
    key: string;
    encryptedValue: string;
    createdAt: string;
    updatedAt: string;
}
/**
 * What a store knows about a secret without revealing it.
 *
 * A settings screen can show that a credential is configured and when it last
 * changed without ever reading the value back.
 */
export interface SecretMetadata {
    key: string;
    createdAt: string;
    updatedAt: string;
}
/**
 * Persistence for ciphertext. Implementations store the encrypted value
 * exactly as given and never see a plaintext secret.
 */
export interface VaultStore {
    get(workspaceId: string, key: string): Promise<string | null>;
    set(workspaceId: string, key: string, value: string): Promise<void>;
    delete(workspaceId: string, key: string): Promise<void>;
    listMetadata(workspaceId: string): Promise<SecretMetadata[]>;
}
/**
 * Plaintext read access to workspace secrets.
 *
 * The method name differs from `VaultStore.get` so a ciphertext-level store
 * cannot be passed where decrypted secrets are expected.
 */
export interface SecretReader {
    getSecret(workspaceId: string, key: string): Promise<string | null>;
}
/**
 * Plaintext read/write access to workspace secrets.
 *
 * The method names deliberately differ from `VaultStore` so a ciphertext-level
 * store cannot be passed where decrypted secrets are expected.
 */
export interface SecretStore extends SecretReader {
    setSecret(workspaceId: string, key: string, value: string): Promise<void>;
    deleteSecret(workspaceId: string, key: string): Promise<void>;
    listSecrets(workspaceId: string): Promise<string[]>;
}
/**
 * A set of master keys, one of which is active.
 *
 * New secrets are encrypted with the active key. Secrets written under any
 * other key in the keyring stay readable, which is what makes a master key
 * rotation possible without downtime. The ids are labels for humans: a secret
 * names the key material that wrote it, not the label it had at the time.
 */
export interface VaultKeyring {
    /** Id of the key new secrets are encrypted with. */
    activeKeyId: string;
    /** Master keys by id. Each value is 64 hex characters (32 bytes). */
    keys: Record<string, string>;
}
/**
 * Per-workspace encrypted credential storage.
 *
 * Each workspace's secrets are encrypted with a key derived from the master
 * key and the workspace id, so one workspace's secrets cannot be read with
 * another workspace's key, and changing the master key invalidates every
 * secret written under the old one.
 */
export declare class Vault implements SecretStore {
    private readonly store;
    private readonly keyring;
    private index;
    constructor(store: VaultStore, masterKey: string | VaultKeyring);
    /** Id of the master key new secrets are encrypted with. */
    get activeKeyId(): string;
    getSecret(workspaceId: string, key: string): Promise<string | null>;
    setSecret(workspaceId: string, key: string, value: string): Promise<void>;
    deleteSecret(workspaceId: string, key: string): Promise<void>;
    listSecrets(workspaceId: string): Promise<string[]>;
    /** Describes the secrets a workspace holds, without revealing any of them. */
    listSecretMetadata(workspaceId: string): Promise<SecretMetadata[]>;
    /**
     * Re-encrypts one secret under the active master key.
     *
     * Returns false when the secret is missing or already under the active key.
     */
    reencryptSecret(workspaceId: string, key: string): Promise<boolean>;
    /** Re-encrypts every secret held for a workspace. Returns how many changed. */
    reencryptWorkspace(workspaceId: string): Promise<number>;
    private workspaceKey;
    /** The reference a secret written with the given key id carries. */
    private refFor;
    /**
     * The keyring's keys, indexed both by the id the operator gave them and by
     * the reference a secret carries. Built once, on first use.
     */
    private keyIndex;
}
export declare function createInMemoryVaultStore(): VaultStore;
