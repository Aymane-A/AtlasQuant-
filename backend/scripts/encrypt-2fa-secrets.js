/**
 * One-off: chiffre tous les users.twofa_secret encore en clair.
 *   cd backend && node scripts/encrypt-2fa-secrets.js
 * Idempotent (les valeurs déjà "enc:v1:" sont ignorées). Nécessite DB_* /
 * DATABASE_URL et EXCHANGE_ENCRYPTION_KEY dans .env.
 */
require('dotenv').config();
const db = require('../src/config/db');
const { encryptTotpSecret, isEncryptedTotpSecret, hasEncryptionKey } = require('../src/utils/secretBox');

(async () => {
  if (!hasEncryptionKey()) { console.error('EXCHANGE_ENCRYPTION_KEY manquante/invalide'); process.exit(1); }
  await db.ready;
  const { rows } = await db.query('SELECT id, twofa_secret FROM users WHERE twofa_secret IS NOT NULL');
  let done = 0;
  for (const r of rows) {
    if (isEncryptedTotpSecret(r.twofa_secret)) continue;
    await db.query('UPDATE users SET twofa_secret = $1 WHERE id = $2', [encryptTotpSecret(r.twofa_secret), r.id]);
    done++;
  }
  console.log(`2FA secrets chiffrés: ${done} / ${rows.length}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
