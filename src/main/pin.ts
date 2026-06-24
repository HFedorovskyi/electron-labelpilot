/**
 * pin.ts — PIN verification against Django's pbkdf2_sha256 password hashes.
 *
 * The server stores an operator's PIN as a Django password hash of the form:
 *     pbkdf2_sha256$<iterations>$<salt>$<base64-hash>
 *
 * This is Layer C (operator-login: workflow/audit/UX), NOT a security boundary — the
 * local SQLite is unencrypted on an operator-controlled machine. The policy is FAIL-OPEN
 * for legitimate operators (an operator with NO pin logs in with no prompt), but a WRONG
 * pin must still be rejected (returning true on a bad pin would be absurd, not lenient).
 */

import crypto from 'crypto';

/**
 * Validate `pin` against a Django pbkdf2_sha256 `pinHash`.
 *
 *  - Empty / blank `pinHash` → the operator has NO pin → allow (returns true). The caller
 *    should not even prompt for a PIN in this case.
 *  - Unrecognized hash format → cannot verify → reject (returns false). FAIL-OPEN does NOT
 *    apply to a wrong/unverifiable pin; it must never crash, though.
 *  - Correct pin → true; incorrect → false. Compared with timingSafeEqual.
 */
export function verifyPin(pin: string, pinHash: string | null | undefined): boolean {
    // No PIN set on this operator → no prompt, allow.
    if (pinHash === null || pinHash === undefined || String(pinHash).trim() === '') {
        return true;
    }

    try {
        const parts = String(pinHash).split('$');
        // Expected: ['pbkdf2_sha256', '<iters>', '<salt>', '<b64hash>']
        if (parts.length !== 4) return false;

        const [algo, itersStr, salt, expectedB64] = parts;
        if (algo !== 'pbkdf2_sha256') return false;

        const iterations = parseInt(itersStr, 10);
        if (!Number.isFinite(iterations) || iterations <= 0) return false;
        if (!salt || !expectedB64) return false;

        const expected = Buffer.from(expectedB64, 'base64');
        // Django uses the digest's native length (sha256 → 32 bytes).
        const keylen = expected.length || 32;

        const computed = crypto.pbkdf2Sync(String(pin), salt, iterations, keylen, 'sha256');

        if (computed.length !== expected.length) return false;
        return crypto.timingSafeEqual(computed, expected);
    } catch {
        // Never crash the login path over a malformed hash — just reject.
        return false;
    }
}
