export declare function deriveWorkspaceKey(masterKeyHex: string, workspaceId: string): Promise<CryptoKey>;
export declare function encrypt(plaintext: string, key: CryptoKey): Promise<string>;
export declare function decrypt(ciphertext: string, key: CryptoKey): Promise<string>;
