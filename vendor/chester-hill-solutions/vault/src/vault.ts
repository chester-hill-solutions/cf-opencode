import {
  VaultKeyError,
  decrypt,
  deriveWorkspaceKey,
  encrypt,
  keyFingerprint,
  parseCiphertext,
  parseMasterKey,
} from "./encryption.js";

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

const DEFAULT_KEY_ID = "default";

interface VaultKeyIndex {
  /** Fingerprint by the id the operator gave the key. */
  byId: Map<string, string>;
  /** Master key material by fingerprint. */
  byRef: Map<string, string>;
}

function normalizeKeyring(masterKey: string | VaultKeyring): VaultKeyring {
  const candidate: Partial<VaultKeyring> =
    typeof masterKey === "string"
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
    } catch (error) {
      throw new VaultKeyError(
        `Master key "${id}" is invalid: ${(error as Error).message}`,
      );
    }
  }
  if (!keys[candidate.activeKeyId]) {
    throw new VaultKeyError(
      `Vault keyring has no master key for the active key id "${candidate.activeKeyId}".`,
    );
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
export class Vault implements SecretStore {
  private readonly keyring: VaultKeyring;
  private index: VaultKeyIndex | null = null;

  constructor(
    private readonly store: VaultStore,
    masterKey: string | VaultKeyring,
  ) {
    this.keyring = normalizeKeyring(masterKey);
  }

  /** Id of the master key new secrets are encrypted with. */
  get activeKeyId(): string {
    return this.keyring.activeKeyId;
  }

  async getSecret(workspaceId: string, key: string): Promise<string | null> {
    const stored = await this.store.get(workspaceId, key);
    if (!stored) return null;
    const { keyRef } = parseCiphertext(stored);
    return decrypt(stored, await this.workspaceKey(workspaceId, keyRef));
  }

  async setSecret(workspaceId: string, key: string, value: string): Promise<void> {
    const activeKeyId = this.keyring.activeKeyId;
    const activeRef = await this.refFor(activeKeyId);
    const encrypted = await encrypt(
      value,
      await this.workspaceKey(workspaceId, activeRef),
      activeRef,
    );
    await this.store.set(workspaceId, key, encrypted);
  }

  async deleteSecret(workspaceId: string, key: string): Promise<void> {
    await this.store.delete(workspaceId, key);
  }

  async listSecrets(workspaceId: string): Promise<string[]> {
    const metadata = await this.store.listMetadata(workspaceId);
    return metadata.map(entry => entry.key);
  }

  /** Describes the secrets a workspace holds, without revealing any of them. */
  async listSecretMetadata(workspaceId: string): Promise<SecretMetadata[]> {
    return this.store.listMetadata(workspaceId);
  }

  /**
   * Re-encrypts one secret under the active master key.
   *
   * Returns false when the secret is missing or already under the active key.
   */
  async reencryptSecret(workspaceId: string, key: string): Promise<boolean> {
    const stored = await this.store.get(workspaceId, key);
    if (!stored) return false;
    const { keyRef } = parseCiphertext(stored);
    const activeRef = await this.refFor(this.keyring.activeKeyId);
    if (keyRef === activeRef) return false;
    const plaintext = await decrypt(stored, await this.workspaceKey(workspaceId, keyRef));
    await this.store.set(
      workspaceId,
      key,
      await encrypt(plaintext, await this.workspaceKey(workspaceId, activeRef), activeRef),
    );
    return true;
  }

  /** Re-encrypts every secret held for a workspace. Returns how many changed. */
  async reencryptWorkspace(workspaceId: string): Promise<number> {
    const keys = await this.listSecrets(workspaceId);
    let migrated = 0;
    for (const key of keys) {
      if (await this.reencryptSecret(workspaceId, key)) migrated++;
    }
    return migrated;
  }

  private async workspaceKey(workspaceId: string, keyRef: string): Promise<CryptoKey> {
    const hex = (await this.keyIndex()).byRef.get(keyRef);
    if (!hex) {
      throw new VaultKeyError(
        `Secret was encrypted with master key ${keyRef}, which is not in the keyring. Add that master key to read it.`,
      );
    }
    return deriveWorkspaceKey(hex, workspaceId);
  }

  /** The reference a secret written with the given key id carries. */
  private async refFor(keyId: string): Promise<string> {
    const ref = (await this.keyIndex()).byId.get(keyId);
    if (!ref) {
      throw new VaultKeyError(
        `Vault keyring has no master key for "${keyId}".`,
      );
    }
    return ref;
  }

  /**
   * The keyring's keys, indexed both by the id the operator gave them and by
   * the reference a secret carries. Built once, on first use.
   */
  private async keyIndex(): Promise<VaultKeyIndex> {
    if (!this.index) {
      const byId = new Map<string, string>();
      const byRef = new Map<string, string>();
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

export function createInMemoryVaultStore(): VaultStore {
  const store = new Map<string, Map<string, { value: string; createdAt: string; updatedAt: string }>>();
  return {
    async get(workspaceId, key) {
      return store.get(workspaceId)?.get(key)?.value ?? null;
    },
    async set(workspaceId, key, value) {
      if (!store.has(workspaceId)) store.set(workspaceId, new Map());
      const secrets = store.get(workspaceId)!;
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
