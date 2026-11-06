const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
async function getMasterKey(masterKeyHex) {
    // Read the env fallback structurally so this module type-checks without
    // Node types and never references `process` in a Workers bundle.
    const env = globalThis.process?.env;
    const hex = masterKeyHex ?? env?.VAULT_MASTER_KEY;
    if (!hex)
        throw new Error("VAULT_MASTER_KEY environment variable required");
    const keyBytes = new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((pair) => Number.parseInt(pair, 16)));
    return crypto.subtle.importKey("raw", keyBytes, ALGORITHM, false, ["encrypt", "decrypt"]);
}
export async function deriveWorkspaceKey(masterKeyHex, workspaceId) {
    const masterKey = await getMasterKey(masterKeyHex);
    const encoder = new TextEncoder();
    const hkdfKey = await crypto.subtle.importKey("raw", encoder.encode(workspaceId), { name: "HKDF" }, false, ["deriveBits"]);
    const derivedBits = await crypto.subtle.deriveBits({
        name: "HKDF",
        salt: encoder.encode("workspace-vault-key"),
        info: encoder.encode("chester-hill-solutions/vault"),
        hash: "SHA-256",
    }, hkdfKey, KEY_LENGTH);
    return crypto.subtle.importKey("raw", new Uint8Array(derivedBits), { name: ALGORITHM }, false, ["encrypt", "decrypt"]);
}
/** Base64 helpers that work in Workers and Bun alike (no Node Buffer). */
function toBase64(bytes) {
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary);
}
function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
        bytes[index] = binary.charCodeAt(index);
    return bytes;
}
export async function encrypt(plaintext, key) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const encrypted = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return toBase64(combined);
}
export async function decrypt(ciphertext, key) {
    const combined = fromBase64(ciphertext);
    const iv = new Uint8Array(combined.subarray(0, IV_LENGTH));
    const data = new Uint8Array(combined.subarray(IV_LENGTH));
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
    return new TextDecoder().decode(decrypted);
}
