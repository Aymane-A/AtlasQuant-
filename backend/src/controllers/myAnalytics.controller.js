/**
 * controllers/myAnalytics.controller.js — AtlasQuant AI
 *
 * "Mon P&L": performance RÉELLE de l'utilisateur connecté.
 *   mode=paper (défaut) → paper_trades (manuels + AutoTrader)
 *   mode=live           → live_orders réconciliés avec l'exchange, appariés
 *                         en aller-retours FIFO (achat → vente, spot)
 *   mode=all            → les deux
 *
 * Route: GET /api/signals/analytics/mine?period=1M&mode=paper   (protect)
 *
 * - % du capital: uniquement en mode paper. Le capital paper de départ est
 *   PAPER_START_CAPITAL (10 000 $ par défaut, la même valeur que getBalance()
 *   utilise pour le sizing de l'AutoTrader). En live on ne connaît pas ton
 *   capital réel → pas de % du capital.
 * - Moi vs IA: pour les trades liés à un signal (signal_id), on compare ton
 *   résultat au résultat du signal (TP/SL calculé par outcomeResolver).
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const { PAPER_START_CAPITAL } = require('../services/exchanges.service');

const PERIOD_DAYS   = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
const MIN_SAMPLE    = 30;
const JOURNAL_LIMIT = 50;
const STABLES       = ['USDT', 'USD', 'USDC', 'BUSD'];

const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2  = n => Math.round(n * 100) / 100;
const fmtMoney = n => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)} $`;
const sgn = (n, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

const monthLabel = d => new Date(d).toLocaleString('fr-FR', { timeZone: 'UTC', month: 'short', year: 'numeric' });
const dayLabel   = d => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short' });

function fmtDuration(ms) {
    const min = ms / 60000;
    if (min < 60) return `${Math.max(1, Math.round(min))}min`;
    const h = min / 60;
    if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
    return `${(h / 24).toFixed(1)}j`;
}

function fmtPrice(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1000) return n.toFixed(1);
    if (n >= 100)  return n.toFixed(2);
    if (n >= 1)    return n.toFixed(3);
    return n.toFixed(5);
}

function summarize(list) {
    const wins   = list.filter(t => t.pnl > 0);
    const losses = list.filter(t => t.pnl < 0);
    const grossWin  = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    return {
        n: list.length,
        wins: wins.length,
        total: list.reduce((a, t) => a + t.pnl, 0),
        winRate: list.length ? (wins.length / list.length) * 100 : null,
        avgWin:  wins.length ? grossWin / wins.length : 0,
        avgLoss: losses.length ? grossLoss / losses.length : 0,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
        expectancy: list.length ? avg(list.map(t => t.pnl)) : null,
    };
}

function groupStats(list, keyFn) {
    const map = new Map();
    for (const t of list) {
        const k = keyFn(t);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(t);
    }
    return [...map.entries()].map(([key, items]) => {
        const s = summarize(items);
        return {
            key,
            n: s.n,
            winRate: s.winRate == null ? null : parseFloat(s.winRate.toFixed(1)),
            pnl: r2(s.total),
            expectancy: s.expectancy == null ? null : r2(s.expectancy),
        };
    }).sort((a, b) => b.pnl - a.pnl);
}

// ── Live: apparie les ordres exécutés en aller-retours FIFO (spot, long) ──
// Entrée: ordres déjà réconciliés (fill_final = true, filled_qty/avg_price connus).
// Sortie: trades clos, lots encore ouverts, quantités vendues sans achat connu.
function buildLiveTrips(orders) {
    const lotsByKey = new Map();
    const trips = [];
    let unmatchedQty = 0, feeUnknown = 0, usedOrders = 0;

    for (const o of orders) {
        const qty = parseFloat(o.filled_qty);
        const px  = parseFloat(o.avg_price);
        if (!o.fill_final || !(qty > 0) || !(px > 0)) continue;
        usedOrders++;

        const side   = String(o.side).toLowerCase();
        const symbol = String(o.symbol).toUpperCase();
        const [base, quoteRaw] = symbol.includes('/') ? symbol.split('/') : [symbol, 'USDT'];
        const isStock = o.exchange_id === 'alpaca';          // actions: cotées en USD, pas de paire
        const quote = quoteRaw || (isStock ? 'USD' : 'USDT');
        const label = isStock ? base : `${base}/${quote}`;
        const key = `${o.exchange_id}|${base}`;

        // Frais convertis en monnaie de cotation
        const fc  = o.fee_cost != null ? parseFloat(o.fee_cost) : 0;
        const cur = String(o.fee_currency || '').toUpperCase();
        let feeQuote = 0;
        if (fc > 0) {
            if (cur === quote || STABLES.includes(cur)) feeQuote = fc;
            else if (cur === base) feeQuote = fc * px;
            else feeUnknown++;   // ex: frais payés en BNB → non comptés
        }

        const at = new Date(o.created_at);
        if (!lotsByKey.has(key)) lotsByKey.set(key, []);
        const lots = lotsByKey.get(key);

        if (side === 'buy') {
            lots.push({
                qty, qty0: qty, price: px, fee: feeQuote, at,
                exchange: o.exchange_id, symbol: label,
                signalId: o.signal_id ?? null,
                sigConf: o.sig_conf ?? null, sigOutcome: o.sig_outcome ?? null,
                sigPnlPct: o.sig_pnl_pct != null ? parseFloat(o.sig_pnl_pct) : null,
            });
        } else if (side === 'sell') {
            let remaining = qty;
            while (remaining > 1e-12 && lots.length) {
                const lot  = lots[0];
                const take = Math.min(lot.qty, remaining);
                const buyFee  = lot.fee * (take / lot.qty0);
                const sellFee = feeQuote * (take / qty);
                const pnl = (px - lot.price) * take - buyFee - sellFee;
                trips.push({
                    exchange: lot.exchange, symbol: lot.symbol, qty: take,
                    entry: lot.price, exit: px, pnl,
                    pnlPct: lot.price * take > 0 ? (pnl / (lot.price * take)) * 100 : 0,
                    opened_at: lot.at, closed_at: at,
                    signalId: lot.signalId, sigConf: lot.sigConf,
                    sigOutcome: lot.sigOutcome, sigPnlPct: lot.sigPnlPct,
                });
                lot.qty -= take;
                remaining -= take;
                if (lot.qty <= 1e-12) lots.shift();
            }
            if (remaining > 1e-12) unmatchedQty += remaining;   // vendu sans achat connu
        }
    }

    const openLots = [];
    for (const lots of lotsByKey.values()) for (const l of lots) openLots.push(l);
    return { trips, openLots, unmatchedQty, feeUnknown, usedOrders };
}

const emptyPayload = (mode) => ({
    success: true, mode, kpis: [], equity: [], monthly: [], trades: [], openPositions: [],
    breakdowns: { bySource: [], bySymbol: [], byExchange: [] },
    metrics: [], breakevenWR: null, capital: null, live: null,
    signalLink: { linked: 0, unlinked: 0, aiWinRate: null, myWinRate: null, avgSignalPnlPct: null, avgMyPnlPct: null, gap: null, byGroup: [] },
    sample: { closed: 0, open: 0, min: MIN_SAMPLE, low: true },
});

async function getMyAnalytics(req, res) {
    try {
        // Selon ton middleware `protect`, l'id peut s'appeler id / userId.
        const userId = req.user?.id ?? req.user?.userId ?? req.userId;
        if (!userId) return res.status(401).json({ success: false, error: 'Non authentifié' });

        const mode = ['paper', 'live', 'all'].includes(req.query.mode) ? req.query.mode : 'paper';
        const wantPaper = mode === 'paper' || mode === 'all';
        const wantLive  = mode === 'live'  || mode === 'all';

        const days   = PERIOD_DAYS[req.query.period];
        const cutoff = days ? new Date(Date.now() - days * 86400000) : null;

        const paperParams = days ? [userId, days] : [userId];
        const paperWhere  = days ? `AND p.closed_at >= NOW() - make_interval(days => $2::int)` : '';

        const [paperClosedRes, paperOpenRes, liveRes] = await Promise.all([
            wantPaper ? db.query(`
                SELECT p.id, p.exchange_id, p.symbol, p.side, p.quantity, p.price, p.exit_price,
                       p.pnl, p.pnl_pct, p.opened_at, p.closed_at, p.close_reason,
                       p.auto_trade_config_id, p.signal_id,
                       s.confidence AS sig_conf, s.outcome AS sig_outcome, s.pnl_pct AS sig_pnl_pct
                FROM paper_trades p
                LEFT JOIN signals s ON s.id = p.signal_id
                WHERE p.user_id = $1 AND p.status = 'closed' AND p.pnl IS NOT NULL ${paperWhere}
                ORDER BY p.closed_at ASC
            `, paperParams) : { rows: [] },
            wantPaper ? db.query(`
                SELECT id, exchange_id, symbol, side, quantity, price, stop_loss, take_profit,
                       opened_at, auto_trade_config_id
                FROM paper_trades
                WHERE user_id = $1 AND status = 'open'
                ORDER BY opened_at DESC LIMIT 50
            `, [userId]) : { rows: [] },
            // Live: on prend TOUT l'historique (le FIFO a besoin des achats anciens),
            // le filtre de période est appliqué après appariement.
            wantLive ? db.query(`
                SELECT o.id, o.exchange_id, o.symbol, o.side, o.filled_qty, o.avg_price,
                       o.fee_cost, o.fee_currency, o.fill_final, o.signal_id, o.created_at,
                       s.confidence AS sig_conf, s.outcome AS sig_outcome, s.pnl_pct AS sig_pnl_pct
                FROM live_orders o
                LEFT JOIN signals s ON s.id = o.signal_id
                WHERE o.user_id = $1
                ORDER BY o.created_at ASC
            `, [userId]) : { rows: [] },
        ]);

        // ── Trades clos normalisés ──
        const paperClosed = paperClosedRes.rows.map(r => {
            const entry = parseFloat(r.price);
            const qty   = parseFloat(r.quantity);
            const pnl   = parseFloat(r.pnl);
            return {
                mode: 'paper',
                exchange_id: r.exchange_id,
                symbol: String(r.symbol).toUpperCase(),
                side: r.side,
                qty, entry, pnl,
                exit: r.exit_price != null ? parseFloat(r.exit_price) : null,
                pnlPct: r.pnl_pct != null ? parseFloat(r.pnl_pct) : (entry * qty > 0 ? (pnl / (entry * qty)) * 100 : 0),
                opened_at: new Date(r.opened_at),
                closed_at: new Date(r.closed_at),
                source: r.auto_trade_config_id != null ? 'AutoTrader' : 'Manuel',
                reason: r.close_reason || '—',
                signalId: r.signal_id ?? null,
                sigConf: r.sig_conf ?? null,
                sigOutcome: r.sig_outcome ?? null,
                sigPnlPct: r.sig_pnl_pct != null ? parseFloat(r.sig_pnl_pct) : null,
            };
        });

        let liveMeta = null;
        let liveClosed = [];
        let liveOpenLots = [];
        if (wantLive) {
            const L = buildLiveTrips(liveRes.rows);
            liveClosed = L.trips
                .filter(t => !cutoff || t.closed_at >= cutoff)
                .map(t => ({
                    mode: 'live', exchange_id: t.exchange, symbol: t.symbol, side: 'buy',
                    qty: t.qty, entry: t.entry, exit: t.exit, pnl: t.pnl, pnlPct: t.pnlPct,
                    opened_at: t.opened_at, closed_at: t.closed_at,
                    source: 'Manuel', reason: 'vente',
                    signalId: t.signalId, sigConf: t.sigConf, sigOutcome: t.sigOutcome, sigPnlPct: t.sigPnlPct,
                }));
            liveOpenLots = L.openLots;
            liveMeta = {
                orders:       liveRes.rows.length,
                reconciled:   L.usedOrders,
                pending:      liveRes.rows.filter(o => !o.fill_final).length,
                unmatchedQty: parseFloat(L.unmatchedQty.toFixed(8)),
                feeUnknown:   L.feeUnknown,
            };
        }

        const closed = [...paperClosed, ...liveClosed].sort((a, b) => a.closed_at - b.closed_at);

        const openPositions = [
            ...paperOpenRes.rows.map(r => ({
                mode: 'paper',
                sym: String(r.symbol).toUpperCase(),
                exchange: r.exchange_id,
                source: r.auto_trade_config_id != null ? 'AutoTrader' : 'Manuel',
                side: r.side === 'buy' ? 'Long' : 'Short',
                qty: parseFloat(r.quantity),
                entry: fmtPrice(parseFloat(r.price)),
                sl: r.stop_loss != null ? fmtPrice(parseFloat(r.stop_loss)) : '—',
                tp: r.take_profit != null ? fmtPrice(parseFloat(r.take_profit)) : '—',
                openedAt: new Date(r.opened_at).toISOString().slice(0, 16).replace('T', ' '),
            })),
            ...liveOpenLots.map(l => ({
                mode: 'live', sym: l.symbol, exchange: l.exchange, source: 'Manuel', side: 'Long',
                qty: parseFloat(l.qty.toFixed(8)), entry: fmtPrice(l.price), sl: '—', tp: '—',
                openedAt: l.at.toISOString().slice(0, 16).replace('T', ' '),
            })),
        ];

        const nothingYet = !closed.length && !openPositions.length && !(liveMeta && liveMeta.orders);
        if (nothingYet) return res.json(emptyPayload(mode));

        // ── Stats ──
        const capital = mode === 'paper' ? PAPER_START_CAPITAL : null;
        const S   = summarize(closed);
        const low = closed.length < MIN_SAMPLE;
        const breakevenWR = S.avgWin > 0 && S.avgLoss > 0
            ? parseFloat(((S.avgLoss / (S.avgWin + S.avgLoss)) * 100).toFixed(1)) : null;

        let cum = 0, peak = 0, maxDD = 0;
        const equity = closed.map(t => {
            cum += t.pnl;
            if (cum > peak) peak = cum;
            maxDD = Math.max(maxDD, peak - cum);
            return { day: dayLabel(t.closed_at), cumul: r2(cum), pnl: r2(t.pnl) };
        });

        const monthMap = {};
        closed.forEach(t => {
            const key = monthLabel(t.closed_at);
            const m = monthMap[key] || (monthMap[key] = { sum: 0, count: 0, wins: 0 });
            m.sum += t.pnl; m.count++; if (t.pnl > 0) m.wins++;
        });
        const monthly = Object.entries(monthMap).map(([month, v]) => ({
            month, ret: r2(v.sum), count: v.count, winRate: Math.round((v.wins / v.count) * 100),
        }));

        const trades = closed.slice().reverse().slice(0, JOURNAL_LIMIT).map(t => ({
            date:     t.closed_at.toISOString().slice(0, 10),
            mode:     t.mode,
            sym:      t.symbol,
            exchange: t.exchange_id,
            source:   t.source,
            side:     t.side === 'buy' ? 'Long' : 'Short',
            qty:      t.qty,
            entry:    fmtPrice(t.entry),
            exit:     fmtPrice(t.exit),
            pnl:      fmtMoney(t.pnl),
            pnlRaw:   r2(t.pnl),
            pnlPct:   sgn(t.pnlPct),
            duration: fmtDuration(t.closed_at - t.opened_at),
            reason:   t.reason,
            signal:   t.signalId != null ? `IA${t.sigConf != null ? ` ${t.sigConf}%` : ''}` : '—',
        }));

        const pfValue = S.profitFactor == null ? '—' : S.profitFactor === Infinity ? '∞' : S.profitFactor.toFixed(2);
        const kpis = [
            { label: 'P&L Total', v: closed.length ? fmtMoney(S.total) : '—',
              sub: capital && closed.length
                ? `${sgn((S.total / capital) * 100)} du capital paper (${capital.toLocaleString('fr-FR')} $) · ${closed.length} clos`
                : `${closed.length} trades clos · ${openPositions.length} ouverts`,
              color: S.total >= 0 ? 'var(--green)' : 'var(--red)' },
            { label: 'Win Rate', v: closed.length ? S.winRate.toFixed(1) + '%' : '—',
              sub: breakevenWR != null ? `breakeven ${breakevenWR}% (selon tes gains/pertes)` : `${S.wins}/${closed.length} gagnants`,
              color: low ? 'var(--amber)' : 'var(--green)' },
            { label: 'Profit Factor', v: pfValue, sub: 'gains bruts / pertes brutes',
              color: S.profitFactor == null ? 'var(--cyan)' : S.profitFactor >= 1 ? 'var(--green)' : 'var(--red)' },
            { label: 'Expectancy', v: S.expectancy == null ? '—' : fmtMoney(S.expectancy),
              sub: 'gain moyen par trade',
              color: S.expectancy == null ? 'var(--cyan)' : S.expectancy >= 0 ? 'var(--green)' : 'var(--red)' },
            { label: 'Max Drawdown', v: closed.length ? `-${maxDD.toFixed(2)} $` : '—',
              sub: capital && closed.length ? `-${((maxDD / capital) * 100).toFixed(2)}% du capital` : 'pic → creux du P&L cumulé',
              color: maxDD > 0 ? 'var(--red)' : 'var(--cyan)' },
        ];

        const durations = closed.map(t => t.closed_at - t.opened_at);
        const best  = closed.length ? Math.max(...closed.map(t => t.pnl)) : null;
        const worst = closed.length ? Math.min(...closed.map(t => t.pnl)) : null;
        const metrics = [
            { label: 'Gain moyen',    value: S.avgWin > 0 ? fmtMoney(S.avgWin) : '—', tone: 'pos', hint: 'trades gagnants' },
            { label: 'Perte moyenne', value: S.avgLoss > 0 ? fmtMoney(-S.avgLoss) : '—', tone: 'neg', hint: 'trades perdants' },
            { label: 'R:R réalisé',   value: S.avgWin > 0 && S.avgLoss > 0 ? `1:${(S.avgWin / S.avgLoss).toFixed(2)}` : '—', hint: 'gain moyen / perte moyenne' },
            { label: 'Durée moyenne', value: durations.length ? fmtDuration(avg(durations)) : '—', hint: 'ouverture → fermeture' },
            { label: 'Meilleur trade', value: best  == null ? '—' : fmtMoney(best),  tone: best  > 0 ? 'pos' : undefined },
            { label: 'Pire trade',     value: worst == null ? '—' : fmtMoney(worst), tone: worst < 0 ? 'neg' : undefined },
            { label: 'Trades auto',    value: String(closed.filter(t => t.source === 'AutoTrader').length), hint: "ouverts par l'AutoTrader" },
            { label: 'Trades manuels', value: String(closed.filter(t => t.source === 'Manuel').length), hint: 'ouverts par toi' },
        ];

        // ── Moi vs IA ──
        const linked   = closed.filter(t => t.signalId != null);
        const unlinked = closed.filter(t => t.signalId == null);
        const withSig  = linked.filter(t => ['TP', 'SL', 'EXPIRED'].includes(t.sigOutcome) && t.sigPnlPct != null);
        const aiWinRate = withSig.length ? (withSig.filter(t => t.sigPnlPct > 0).length / withSig.length) * 100 : null;
        const myWinRate = linked.length  ? (linked.filter(t => t.pnl > 0).length / linked.length) * 100 : null;
        // même échantillon des deux côtés (trades liés dont le signal est clos)
        const avgSignalPnlPct = withSig.length ? avg(withSig.map(t => t.sigPnlPct)) : null;
        const avgMyPnlPct     = withSig.length ? avg(withSig.map(t => t.pnlPct)) : null;
        const signalLink = {
            linked: linked.length,
            unlinked: unlinked.length,
            comparable: withSig.length,
            aiWinRate:  aiWinRate == null ? null : parseFloat(aiWinRate.toFixed(1)),
            myWinRate:  myWinRate == null ? null : parseFloat(myWinRate.toFixed(1)),
            avgSignalPnlPct: avgSignalPnlPct == null ? null : r2(avgSignalPnlPct),
            avgMyPnlPct:     avgMyPnlPct == null ? null : r2(avgMyPnlPct),
            gap: avgSignalPnlPct == null ? null : r2(avgMyPnlPct - avgSignalPnlPct),
            byGroup: groupStats(closed, t => (t.signalId != null ? 'Suit un signal' : 'Sans signal')),
        };

        res.json({
            success: true, mode, kpis, equity, monthly, trades, openPositions,
            breakdowns: {
                bySource:   groupStats(closed, t => (t.mode === 'live' ? 'Live' : t.source)),
                bySymbol:   groupStats(closed, t => t.symbol).slice(0, 10),
                byExchange: groupStats(closed, t => t.exchange_id),
            },
            metrics, breakevenWR, capital, live: liveMeta, signalLink,
            sample: { closed: closed.length, open: openPositions.length, min: MIN_SAMPLE, low },
        });

    } catch (err) {
        logger.error(`[myAnalytics] ${err.message}`);
        res.status(500).json({ success: false, error: 'Analytics unavailable' });
    }
}

module.exports = { getMyAnalytics };