/** Current ciphertext format version. Bump when the derivation or framing changes. */
export declare const CIPHERTEXT_VERSION = "v2";
/** Raised when a master key is missing, malformed, or cannot decrypt a secret. */
export declare class VaultKeyError extends Error {
    constructor(message: string);
}
/**
 * Parses a master key from hex into raw bytes.
 *
 * The master key must be exactly 64 hex characters (32 bytes). Anything else
 * is rejected rather than silently coerced, so a truncated or mistyped key
 * fails at startup instead of producing ciphertext nobody can read.
 */
export declare function parseMasterKey(masterKeyHex: string): Uint8Array<ArrayBuffer>;
/**
 * Derives the per-workspace AES-256-GCM key from the master key.
 *
 * The master key is the HKDF input keying material, so the derived key
 * changes whenever the master key changes. The workspace id only separates
 * one workspace's key from another's.
 */
export declare function deriveWorkspaceKey(masterKeyHex: string, workspaceId: string): Promise<CryptoKey>;
/**
 * A short fingerprint of the master key material.
 *
 * Stored in the ciphertext so a secret names the key that wrote it. Labels in
 * a keyring are for humans and can be renamed freely; the fingerprint cannot
 * drift, so a secret written before a rotation stays readable after it.
 */
export declare function keyFingerprint(masterKeyHex: string): Promise<string>;
export interface ParsedCiphertext {
    version: string;
    keyRef: string;
    payload: string;
}
/**
 * Splits a stored secret into its format version, key reference, and payload.
 *
 * Secrets written before the v2 format carry no version marker and cannot be
 * read back; they are rejected with an actionable message rather than an
 * opaque crypto failure.
 */
export declare function parseCiphertext(value: string): ParsedCiphertext;
/** Encrypts a plaintext into a tagged `v2:<keyRef>:<base64>` ciphertext. */
export declare function encrypt(plaintext: string, key: CryptoKey, keyRef: string): Promise<string>;
/** Decrypts a `v2:<keyId>:<base64>` ciphertext with the key for that key id. */
export declare function decrypt(ciphertext: string, key: CryptoKey): Promise<string>;
