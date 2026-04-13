import { createCipheriv, createDecipheriv, randomBytes, createHash, hkdfSync } from 'crypto';

/**
 * Per-user AES-256-GCM encryption for metadata stored in Supabase.
 *
 * Key derivation: HKDF-SHA256 with ENCRYPTION_SALT as IKM and userId as info.
 * Falls back to legacy SHA-256(userId:salt) for decrypting pre-existing data.
 *
 * The encrypted output format is: iv(12 bytes) + authTag(16 bytes) + ciphertext
 * all encoded as base64. This is stored as a regular text column.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Salt MUST be set in environment — no fallback
function getSalt(): string {
  const salt = process.env.ENCRYPTION_SALT;
  if (!salt) throw new Error('ENCRYPTION_SALT environment variable is required. Set it in Netlify env vars.');
  return salt;
}

/**
 * Derive a 256-bit encryption key from a userId using HKDF.
 * HKDF provides proper key derivation with computational cost.
 */
function deriveKey(userId: string): Buffer {
  const salt = getSalt();
  return Buffer.from(hkdfSync('sha256', salt, userId, 'clearbox-encryption', 32));
}

/**
 * Legacy key derivation for decrypting data encrypted before the HKDF migration.
 */
function deriveKeyLegacy(userId: string): Buffer {
  return createHash('sha256')
    .update(`${userId}:${getSalt()}`)
    .digest();
}

/**
 * Encrypt a plaintext string. Returns base64-encoded ciphertext.
 * Returns empty string for null/undefined/empty input.
 */
export function encrypt(plaintext: string | null | undefined, userId: string): string {
  if (!plaintext) return '';

  const key = deriveKey(userId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext → base64
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext. Returns the original plaintext.
 * Returns empty string for null/undefined/empty input.
 * Returns the input unchanged if it doesn't look encrypted (graceful fallback).
 */
export function decrypt(ciphertext: string | null | undefined, userId: string): string {
  if (!ciphertext) return '';

  try {
    const packed = Buffer.from(ciphertext, 'base64');

    // Minimum size: IV(12) + AuthTag(16) + at least 1 byte of data
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return ciphertext; // Too short to be encrypted, return as-is
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    // Try HKDF-derived key first (current)
    try {
      const key = deriveKey(userId);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      // Fall back to legacy SHA-256 key for pre-migration data
      const legacyKey = deriveKeyLegacy(userId);
      const decipher = createDecipheriv(ALGORITHM, legacyKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    }
  } catch (err) {
    // Log decryption failure for monitoring (don't log the actual data)
    console.warn(`Decryption failed for user ${userId.slice(0, 8)}...: ${err instanceof Error ? err.message : 'unknown'}`);
    // If it looks like it was meant to be encrypted (base64-ish), return empty rather than raw ciphertext
    // Plain legacy text (emails, names) won't be valid base64 of sufficient length
    const packed = Buffer.from(ciphertext, 'base64');
    if (packed.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return ''; // Likely tampered/corrupted encrypted data
    }
    // Short/non-base64 data is likely legacy unencrypted plaintext
    return ciphertext;
  }
}

/**
 * Encrypt specific fields of an object. Returns a new object with encrypted values.
 * Only encrypts string fields that are in the fieldsToEncrypt list.
 */
export function encryptFields<T extends Record<string, unknown>>(
  obj: T,
  fieldsToEncrypt: string[],
  userId: string
): T {
  const result = { ...obj };
  for (const field of fieldsToEncrypt) {
    if (field in result && typeof result[field] === 'string') {
      (result as Record<string, unknown>)[field] = encrypt(result[field] as string, userId);
    }
  }
  return result;
}

/**
 * Decrypt specific fields of an object. Returns a new object with decrypted values.
 * Gracefully handles unencrypted (legacy) data.
 */
export function decryptFields<T extends Record<string, unknown>>(
  obj: T,
  fieldsToDecrypt: string[],
  userId: string
): T {
  const result = { ...obj };
  for (const field of fieldsToDecrypt) {
    if (field in result && typeof result[field] === 'string') {
      (result as Record<string, unknown>)[field] = decrypt(result[field] as string, userId);
    }
  }
  return result;
}

/**
 * Encrypt a JSON object (like the triage_results data column).
 * Serializes to JSON, encrypts the entire string.
 */
export function encryptJson(data: unknown, userId: string): string {
  return encrypt(JSON.stringify(data), userId);
}

/**
 * Decrypt a JSON object that was encrypted with encryptJson.
 * Returns parsed JSON. Falls back to parsing the input directly for legacy data.
 */
export function decryptJson<T = unknown>(ciphertext: string | null | undefined, userId: string): T | null {
  if (!ciphertext) return null;

  // If it's already a valid JSON object/array (legacy unencrypted data), parse directly
  if (typeof ciphertext === 'object') return ciphertext as T;

  const decrypted = decrypt(ciphertext, userId);
  try {
    return JSON.parse(decrypted) as T;
  } catch {
    // If the decrypted result isn't valid JSON, try parsing the original
    try {
      return JSON.parse(ciphertext) as T;
    } catch {
      return null;
    }
  }
}

// Fields that should be encrypted in each table.
// Note: sender_email and account_email are NOT encrypted because they're used as lookup keys.
export const ENCRYPTED_FIELDS = {
  REPLY_QUEUE: ['sender', 'subject', 'summary'],
  SENDER_PRIORITIES: ['display_name'],
  GMAIL_ACCOUNTS: ['access_token', 'refresh_token'],
  ACTION_HISTORY: ['action_label', 'subjects', 'account_email'],
  // TRIAGE_RESULTS uses encryptJson for the entire `data` column
} as const;
