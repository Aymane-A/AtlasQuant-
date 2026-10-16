/**
 * src/utils/secretBox.js — AtlasQuant AI
 * Chiffrement AES-256-GCM des secrets au repos (clés d'exchange, secrets TOTP).
 * Clé : EXCHANGE_ENCRYPTION_KEY (64 caractères hex = 32 bytes).
 * Format stocké : iv(hex):authTag(hex):ciphertext(hex)
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getEncryptionKey() {
  const hex = process.env.EXCHANGE_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('EXCHANGE_ENCRYPTION_KEY manquante/invalide dans .env (64 caractères hex attendus)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plainText) {
  if (plainText == null) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload) {
  if (!payload) return null;
  const key = getEncryptionKey();
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) throw new Error('Format de payload chiffré invalide');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── Secrets TOTP (users.twofa_secret) ───────────────────────────
// ✅ Audit 3: avant, le secret base32 était en clair en base : une fuite de la DB
// donnait les seeds TOTP de tous les comptes. Valeur chiffrée = "enc:v1:" + payload.
// Les anciennes valeurs en clair restent lisibles (migration au fil de l'eau).
const TOTP_PREFIX = 'enc:v1:';

function hasEncryptionKey() {
  const hex = process.env.EXCHANGE_ENCRYPTION_KEY;
  return !!hex && hex.length === 64;
}

function isEncryptedTotpSecret(v) { return typeof v === 'string' && v.startsWith(TOTP_PREFIX); }

/** Chiffre un secret TOTP. Sans clé : erreur en production, clair + warning en dev. */
function encryptTotpSecret(base32) {
  if (!base32) return base32;
  if (isEncryptedTotpSecret(base32)) return base32;
  if (!hasEncryptionKey()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('EXCHANGE_ENCRYPTION_KEY requise pour stocker un secret 2FA en production');
    }
    console.warn('[secretBox] EXCHANGE_ENCRYPTION_KEY absente — secret 2FA stocké en clair (dev uniquement)');
    return base32;
  }
  return TOTP_PREFIX + encrypt(base32);
}

/** Retourne le secret base32 en clair (chiffré ou legacy). */
function decryptTotpSecret(stored) {
  if (!stored) return stored;
  if (!isEncryptedTotpSecret(stored)) return stored;       // legacy plaintext
  return decrypt(stored.slice(TOTP_PREFIX.length));
}

module.exports = {
  encrypt, decrypt, getEncryptionKey,
  encryptTotpSecret, decryptTotpSecret, isEncryptedTotpSecret, hasEncryptionKey,
};
