/**
 * backend/scripts/simulateTradeClose.js — AtlasQuant AI
 *
 * Test manuel de la chaîne "trade auto-trader clôturé par SL/TP" SANS
 * attendre que le marché bouge :
 *   1. ouvre un paper trade de test lié à un config (comme le ferait autoTrader)
 *   2. le ferme à un prix fictif (take_profit) via exchangesSvc.closePaperTrade
 *   3. appelle paperTradeMonitor.onTradeClosed() — le VRAI code exécuté après
 *      chaque clôture : lecture du pnl, recordProbationResult, email/Telegram.
 *
 * Usage (depuis C:\ATLASQUANT\backend) :
 *   node scripts/simulateTradeClose.js          → config #12
 *   node scripts/simulateTradeClose.js 7        → config #7
 *
 * Effets réels : +1 sur probation_trades_completed du config, une ligne
 * 'closed' dans paper_trades (visible dans la page Paper Trading, compte
 * dans P&L / win rate), et un vrai email + message Telegram. À la fin le
 * script affiche le SQL exact pour tout remettre comme avant.
 */

require('dotenv').config();

const db           = require('../src/config/db');
const exchangesSvc = require('../src/services/exchanges.service');
const monitor      = require('../src/services/paperTradeMonitor.service');

const CONFIG_ID = parseInt(process.argv[2], 10) || 12;

// Mêmes niveaux que le vrai trade ^GSPC ouvert par l'auto-trader.
const ENTRY = 7743.41;
const SL    = 7722.88;
const TP    = 7784.46;
const QTY   = 0.5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getConfig() {
  const { rows } = await db.query('SELECT * FROM auto_trade_configs WHERE id = $1', [CONFIG_ID]);
  return rows[0] || null;
}

function show(label, c) {
  console.log(`${label}: status=${c.status} enabled=${c.enabled} probation=${c.probation_trades_completed}/${c.probation_trades_required} wins=${c.probation_wins} pnl=${c.probation_pnl}`);
}

(async () => {
  try {
    const before = await getConfig();
    if (!before) {
      console.log(`❌ Config #${CONFIG_ID} introuvable.`);
      return;
    }
    if (before.status !== 'probation') {
      console.log(`❌ Config #${CONFIG_ID} est en '${before.status}', pas 'probation' — recordProbationResult ne compte que les configs en probation. Abandon.`);
      return;
    }
    show('AVANT ', before);

    // 1. trade de test, lié au config
    const opened = await exchangesSvc.openPaperTrade(before.user_id, before.exchange_id, {
      symbol: before.symbol, side: 'buy', orderType: 'market',
      quantity: QTY, price: ENTRY, limitPrice: null, stopLoss: SL, takeProfit: TP,
    });
    await db.query(
      'UPDATE paper_trades SET auto_trade_config_id = $1, backtest_id = $2 WHERE id = $3',
      [before.id, before.backtest_id, opened.id]
    );
    console.log(`✅ Trade de test #${opened.id} ouvert (${before.symbol} buy @ ${ENTRY})`);

    // 2. clôture à TP
    await exchangesSvc.closePaperTrade(before.user_id, opened.id, TP, 'take_profit');
    console.log(`✅ Trade #${opened.id} clôturé @ ${TP} (take_profit)`);

    // 3. le vrai code post-clôture
    const { rows } = await db.query('SELECT * FROM paper_trades WHERE id = $1', [opened.id]);
    await monitor.onTradeClosed(rows[0], TP, 'take_profit');

    // email / Telegram sont envoyés en arrière-plan : on leur laisse le temps.
    console.log('⏳ Attente 5s pour l\'envoi email/Telegram...');
    await sleep(5000);

    const after = await getConfig();
    show('APRÈS ', after);
    console.log(`Trade #${opened.id}: pnl=${rows[0].pnl} pnl_pct=${rows[0].pnl_pct} status=${rows[0].status}`);

    console.log('\n──────── Pour tout remettre comme avant (psql) ────────');
    console.log(`DELETE FROM paper_trades WHERE id = ${opened.id};`);
    console.log(`UPDATE auto_trade_configs SET probation_trades_completed = ${before.probation_trades_completed}, probation_wins = ${before.probation_wins}, probation_pnl = ${before.probation_pnl} WHERE id = ${before.id};`);
  } catch (err) {
    console.log(`❌ Erreur: ${err.message}`);
  } finally {
    process.exit(0);
  }
})();