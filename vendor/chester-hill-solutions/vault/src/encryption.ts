const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const HKDF_SALT = "chester-hill-solutions/vault";
const HKDF_INFO_PREFIX = "workspace:";
const MASTER_KEY_HEX_LENGTH = 64;
const MASTER_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const KEY_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Current ciphertext format version. Bump when the derivation or framing changes. */
export const CIPHERTEXT_VERSION = "v2";

/** Raised when a master key is missing, malformed, or cannot decrypt a secret. */
export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

/**
 * Parses a master key from hex into raw bytes.
 *
 * The master key must be exactly 64 hex characters (32 bytes). Anything else
 * is rejected rather than silently coerced, so a truncated or mistyped key
 * fails at startup instead of producing ciphertext nobody can read.
 */
export function parseMasterKey(masterKeyHex: string): Uint8Array<ArrayBuffer> {
  const hex = typeof masterKeyHex === "string" ? masterKeyHex.trim() : "";
  if (!MASTER_KEY_PATTERN.test(hex)) {
    throw new VaultKeyError(
      `Master key must be ${MASTER_KEY_HEX_LENGTH} hex characters (32 bytes), e.g. the output of \`openssl rand -hex 32\``,
    );
  }
  const bytes = new Uint8Array(MASTER_KEY_HEX_LENGTH / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function masterKeyBytes(masterKeyHex?: string): Uint8Array<ArrayBuffer> {
  const hex = masterKeyHex ?? process.env.VAULT_MASTER_KEY;
  if (!hex) throw new VaultKeyError("VAULT_MASTER_KEY environment variable required");
  return parseMasterKey(hex);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new VaultKeyError("Stored secret is malformed: the payload is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derives the per-workspace AES-256-GCM key from the master key.
 *
 * The master key is the HKDF input keying material, so the derived key
 * changes whenever the master key changes. The workspace id only separates
 * one workspace's key from another's.
 */
export async function deriveWorkspaceKey(
  masterKeyHex: string,
  workspaceId: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    masterKeyBytes(masterKeyHex),
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(`${HKDF_INFO_PREFIX}${workspaceId}`),
      hash: "SHA-256",
    },
    hkdfKey,
    KEY_LENGTH,
  );
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(derivedBits),
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * A short fingerprint of the master key material.
 *
 * Stored in the ciphertext so a secret names the key that wrote it. Labels in
 * a keyring are for humans and can be renamed freely; the fingerprint cannot
 * drift, so a secret written before a rotation stays readable after it.
 */
export async function keyFingerprint(masterKeyHex: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", parseMasterKey(masterKeyHex));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
export function parseCiphertext(value: string): ParsedCiphertext {
  const match = /^v(\d+):/.exec(value);
  if (!match) {
    throw new VaultKeyError(
      "Stored secret uses the pre-v2 ciphertext format and cannot be decrypted. Re-enter the credential to store it again.",
    );
  }
  const version = `v${match[1]}`;
  if (version !== CIPHERTEXT_VERSION) {
    throw new VaultKeyError(
      `Unsupported secret format ${version}; this vault reads ${CIPHERTEXT_VERSION} only.`,
    );
  }
  const rest = value.slice(match[0].length);
  const separator = rest.indexOf(":");
  if (separator === -1) throw new VaultKeyError("Stored secret is malformed.");
  const keyRef = rest.slice(0, separator);
  const payload = rest.slice(separator + 1);
  if (!KEY_REF_PATTERN.test(keyRef)) throw new VaultKeyError("Stored secret is malformed.");
  if (!payload) throw new VaultKeyError("Stored secret is malformed.");
  return { version, keyRef, payload };
}

/** Encrypts a plaintext into a tagged `v2:<keyRef>:<base64>` ciphertext. */
export async function encrypt(
  plaintext: string,
  key: CryptoKey,
  keyRef: string,
): Promise<string> {
  if (!KEY_REF_PATTERN.test(keyRef)) {
    throw new VaultKeyError(
      `Key reference "${keyRef}" is not allowed; use letters, digits, dot, underscore or dash.`,
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return `${CIPHERTEXT_VERSION}:${keyRef}:${toBase64(combined)}`;
}

/** Decrypts a `v2:<keyId>:<base64>` ciphertext with the key for that key id. */
export async function decrypt(ciphertext: string, key: CryptoKey): Promise<string> {
  const { payload } = parseCiphertext(ciphertext);
  const combined = fromBase64(payload);
  const iv = combined.subarray(0, IV_LENGTH);
  const data = combined.subarray(IV_LENGTH);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new VaultKeyError(
      "Failed to decrypt secret: the master key for this workspace is wrong, or the stored value was altered.",
    );
  }
}
