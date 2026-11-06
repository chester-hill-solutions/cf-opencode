/**
 * Storage-agnostic core: no persistence drivers, so Worker bundles do not pull
 * in the Postgres/Drizzle dependency. Import `@chester-hill-solutions/vault/core`.
 */
export { Vault, createInMemoryVaultStore, createKeyValueVaultStore } from "./vault.js";
export { encrypt, decrypt, deriveWorkspaceKey } from "./encryption.js";
