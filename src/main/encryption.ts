import crypto from 'crypto';

// TODO: In production, this key should be securely managed or injected.
// Using a hardcoded key as requested for this implementation.
// 32 bytes for AES-256
// Key provided by user (Hex)
const SECRET_KEY = Buffer.from('ed8c15735d90145e3caf48e1660c77d512c2e628e044a70526e3a2b4f3a39c11', 'hex');
const ALGORITHM = 'aes-256-cbc';

export function encrypt(data: any): Buffer {
    const jsonStr = JSON.stringify(data);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);

    let encrypted = cipher.update(jsonStr, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    // Return IV + Encrypted Data
    return Buffer.concat([iv, encrypted]);
}

export function decrypt(buffer: Buffer): any {
    try {
        if (buffer.length <= 16) throw new Error('Buffer too short');

        const iv = buffer.slice(0, 16);
        const encryptedData = buffer.slice(16);
        const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);

        let decrypted = decipher.update(encryptedData);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return JSON.parse(decrypted.toString('utf-8'));
    } catch (e: any) {
        // console.warn(`Decryption failed:`, e.message);

        // 1. Try Base64 Decode
        try {
            const asString = buffer.toString('utf-8').trim();
            // Fernet token detection
            if (asString.startsWith('gAAAAA')) {
                throw new Error('File appears to be a Fernet token. Expected AES-256-CBC.');
            }

            if (/^[A-Za-z0-9+/=]+$/.test(asString)) {
                const decoded = Buffer.from(asString, 'base64');
                // Prevent infinite recursion if decoded is same as input (not base64)
                if (decoded.length !== buffer.length) {
                    return decrypt(decoded);
                }
            }
        } catch (ignore) { }

        // 2. JSON Fallback
        try {
            const jsonString = buffer.toString('utf-8');
            const cleanString = jsonString.replace(/^\uFEFF/, '');
            return JSON.parse(cleanString);
        } catch (jsonError) {
            console.error('All Decryption Attempts Failed.');
            console.error('Content Snippet (Hex):', buffer.subarray(0, 50).toString('hex'));
            throw new Error('Invalid file format: Could not decrypt with valid key or parse as JSON.');
        }
    }
}
