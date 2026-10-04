/**
 * controllers/signals.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');

// ── getAllSignals ──────────────────────────────────────────
// refresh=true no longer blocks the request for 25-160s. It creates a
// background job, returns { jobId } immediately, and the frontend polls
// GET /api/signals/scan-status/:jobId for progress until status is 'done'.
async function getAllSignals(req, res) {
    try {
        const { interval = '4h', refresh, class: assetClass } = req.query;

        if (refresh === 'true') {
            const { createJob, updateJob }   = require('../services/scanJob.service');
            const { scanAll, CRYPTO_SYMBOLS } = require('../services/signalGenerator.service');
            const { scanAllYF, YF_SYMBOLS }   = require('../services/yahooFinance.service');

            const jobId      = createJob();
            const cryptoTotal = CRYPTO_SYMBOLS.length;
            const forexTotal  = Object.keys(YF_SYMBOLS).length;
            updateJob(jobId, { cryptoTotal, forexTotal });

            // Respond immediately — the scan itself runs in the background below.
            res.json({ success: true, jobId });

            (async () => {
                try {
                    let cryptoCompleted = 0;
                    let forexCompleted  = 0;

                    const [cryptoResult, yfResult] = await Promise.all([
                        scanAll(interval, () => {
                            cryptoCompleted++;
                            updateJob(jobId, { cryptoCompleted });
                        }),
                        scanAllYF(interval, () => {
                            forexCompleted++;
                            updateJob(jobId, { forexCompleted });
                        }),
                    ]);

                    const allSignals = [
                        ...cryptoResult.signals,
                        ...yfResult,
                    ].sort((a, b) => b.confidence - a.confidence);

                    for (const sig of allSignals) {
                        await db.query(`
                            INSERT INTO signals (symbol, interval, signal, confidence, price, entry, stop_loss, take_profit, risk_reward, reasoning, indicators, asset_class)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                            ON CONFLICT DO NOTHING
                        `, [
                            sig.symbol, interval, sig.signal, sig.confidence,
                            sig.price,
                            sig.entry       || sig.price,
                            sig.stop_loss   || null,
                            sig.take_profit || null,
                            sig.risk_reward || null,
                            sig.reasoning,
                            JSON.stringify(sig.indicators),
                            sig.asset_class || 'Crypto',
                        ]);
                    }

                    const filtered = assetClass
                        ? allSignals.filter(s => s.asset_class === assetClass)
                        : allSignals;

                    updateJob(jobId, { status: 'done', signals: filtered });
                } catch (err) {
                    logger.error(`[getAllSignals] scan job ${jobId} failed: ${err.message}`);
                    updateJob(jobId, { status: 'error', error: err.message });
                }
            })();

            return;
        }

        const query = assetClass
            ? `SELECT * FROM signals WHERE interval = $1 AND asset_class = $2 ORDER BY created_at DESC LIMIT 60`
            : `SELECT * FROM signals WHERE interval = $1 ORDER BY created_at DESC LIMIT 60`;

        const { rows } = assetClass
            ? await db.query(query, [interval, assetClass])
            : await db.query(query, [interval]);

        const signals = rows.map(r => ({
            id:          r.id,
            symbol:      r.symbol,
            interval:    r.interval,
            signal:      r.signal,
            confidence:  r.confidence,
            price:       parseFloat(r.price)       || 0,
            entry:       parseFloat(r.entry)       || null,
            stop_loss:   parseFloat(r.stop_loss)   || null,
            take_profit: parseFloat(r.take_profit) || null,
            risk_reward: r.risk_reward,
            reasoning:   r.reasoning,
            indicators:  r.indicators,
            asset_class: r.asset_class || 'Crypto',
            timestamp:   r.created_at,
        }));

        res.json({ success: true, signals });

    } catch (err) {
        logger.error(`[getAllSignals] ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── getScanStatus ──────────────────────────────────────────
// GET /api/signals/scan-status/:jobId
async function getScanStatus(req, res) {
    const { getJob } = require('../services/scanJob.service');
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found or expired' });
    }

    const total     = job.cryptoTotal + job.forexTotal;
    const completed = job.cryptoCompleted + job.forexCompleted;
    const progress  = total > 0 ? Math.round((completed / total) * 100) : 0;

    res.json({
        success:         true,
        status:          job.status,
        progress,
        completed,
        total,
        cryptoCompleted: job.cryptoCompleted,
        cryptoTotal:     job.cryptoTotal,
        forexCompleted:  job.forexCompleted,
        forexTotal:      job.forexTotal,
        signals:         job.status === 'done'  ? job.signals : undefined,
        error:           job.status === 'error' ? job.error   : undefined,
    });
}

// ── getSignalBySymbol ─────────────────────────────────────
async function getSignalBySymbol(req, res) {
    try {
        const { symbol } = req.params;
        const { rows } = await db.query(
            'SELECT * FROM signals WHERE symbol = $1 ORDER BY created_at DESC LIMIT 10',
            [symbol]
        );
        res.json({ success: true, signals: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── getSupportedSymbols ───────────────────────────────────
async function getSupportedSymbols(req, res) {
    try {
        const { rows } = await db.query('SELECT DISTINCT symbol, asset_class FROM signals ORDER BY asset_class, symbol');
        res.json({ success: true, symbols: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

// ── getAlphaEngineData ────────────────────────────────────
async function getAlphaEngineData(req, res) {
    try {
        res.json({ success: true, data: { modelStatus: 'Active', confidenceScore: 0.92, lastPrediction: 'Bullish' } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Engine data unavailable' });
    }
}

// ═══════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════
const PERIOD_DAYS = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
const DOW_LABELS  = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
const DOW_ORDER   = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];

// En dessous de ce nombre de trades clos, les stats sont indicatives seulement.
const MIN_SAMPLE = 30;
const JOURNAL_LIMIT = 50;

const COLORS = {
    Crypto:    'var(--cyan)',
    Forex:     'var(--purple-bright)',
    Commodity: 'var(--amber)',
    Indices:   'var(--green)',
    Equity:    'var(--blue, #60a5fa)',
};

// Tranches de confidence IA. min inclus, max exclus.
const CONF_BUCKETS = [
    { label: '50-59', min: 0,  max: 60  },
    { label: '60-69', min: 60, max: 70  },
    { label: '70-79', min: 70, max: 80  },
    { label: '80+',   min: 80, max: 101 },
];

// Un même indice peut avoir été stocké sous 2 noms (GSPC / SPX500)
const SYMBOL_ALIASES = {
    GSPC: 'SPX500', '^GSPC': 'SPX500', SPX: 'SPX500',
    NDX:  'NAS100', '^NDX':  'NAS100',
    DJI:  'US30',   '^DJI':  'US30',
    '^VIX': 'VIX',
};
const normSymbol = s => SYMBOL_ALIASES[s] || s;

// Fallback uniquement si une vieille ligne n'a pas de asset_class
function classifyAsset(symbol, fallbackClass) {
    if (fallbackClass) return fallbackClass;
    const s = symbol.toUpperCase();
    const FOREX   = ['EUR','GBP','JPY','CHF','AUD','CAD','NZD'];
    const COMMO   = ['XAU','XAG','OIL','WTI','BRENT','GAS','NATGAS','COPPER','XPT','WHEAT','CORN'];
    const INDICES = ['SPX','NAS100','US30','VIX','SPY','QQQ','DIA','IWM','SPX500','NDX'];
    if (INDICES.some(i => s.includes(i))) return 'Indices';
    if (FOREX.some(f  => s.includes(f) && s.includes('/'))) return 'Forex';
    if (COMMO.some(c  => s.includes(c))) return 'Commodity';
    return 'Crypto';
}

// Tout en UTC: journal, heatmap DoW, labels
const dayLabel   = d => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short' });
const monthLabel = d => new Date(d).toLocaleString('fr-FR',      { timeZone: 'UTC', month: 'short', year: 'numeric' });
const getDow     = d => DOW_LABELS[new Date(d).getUTCDay()];

const avg   = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2    = n => Math.round(n * 100) / 100;
const sgn   = (n, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;

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

const isResolved = t => t.pnl_pct != null && ['TP', 'SL', 'EXPIRED'].includes(t.outcome);

// Un scan toutes les 4h ré-insère le même BUY tant que la position serait
// encore ouverte. On ne compte qu'UN trade par (symbole, interval, direction)
// tant que le précédent n'est pas clos.  rows doit être trié par created_at ASC.
function dedupeTrades(rows) {
    const busyUntil = new Map();
    const kept = [];
    for (const t of rows) {
        const key  = `${t.symbol}|${t.interval}|${t.signal}`;
        const busy = busyUntil.get(key);
        if (busy !== undefined && t.created_at.getTime() < busy) continue; // doublon
        kept.push(t);
        busyUntil.set(key, isResolved(t) && t.closed_at ? t.closed_at.getTime() : Infinity);
    }
    return kept;
}

// Stats de base sur une liste de trades clos
function summarize(list) {
    const wins   = list.filter(t => t.pnl_pct > 0);
    const losses = list.filter(t => t.pnl_pct < 0);
    const grossWin  = wins.reduce((a, t) => a + t.pnl_pct, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl_pct, 0));
    return {
        n: list.length,
        wins: wins.length,
        winRate: list.length ? (wins.length / list.length) * 100 : null,
        avgWin:  wins.length ? grossWin / wins.length : 0,
        avgLoss: losses.length ? grossLoss / losses.length : 0,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
        expectancy: list.length ? avg(list.map(t => t.pnl_pct)) : null,
    };
}

const realizedRR = s => (s.avgWin > 0 && s.avgLoss > 0 ? s.avgWin / s.avgLoss : 0);

const emptyAnalytics = filterClass => ({
    success: true, kpis: [], equity: [], monthly: [], trades: [],
    attribution: [], byDow: [], rolling: [], metrics: [], confidenceBuckets: [],
    distribution: { buy: 0, sell: 0, hold: 0, total: 0 },
    sample: { closed: 0, open: 0, min: MIN_SAMPLE, low: true },
    selectedClass: filterClass || null,
});

// ── getAnalyticsData ──────────────────────────────────────
// - Les signaux 'LEGACY' (anciens signaux calculés avec ATR 1h / prix périmés)
//   sont exclus de TOUT.
// - Les HOLD ne sont jamais chargés ligne par ligne: GROUP BY SQL.
// - P&L: signals.pnl_pct (rempli par outcomeResolver.service.js).
async function getAnalyticsData(req, res) {
    try {
        const { period, class: filterClass } = req.query;
        const days   = PERIOD_DAYS[period];
        const params = days ? [days] : [];

        const baseConds = [`COALESCE(outcome, '') <> 'LEGACY'`];
        if (days) baseConds.push(`created_at >= NOW() - make_interval(days => $1::int)`);

        const whereAgg    = `WHERE ${baseConds.join(' AND ')}`;
        const whereTrades = `WHERE ${[...baseConds, `signal IN ('BUY','SELL')`, `COALESCE(outcome, '') <> 'INVALID'`].join(' AND ')}`;

        const [aggRes, tradeRes] = await Promise.all([
            db.query(`
                SELECT symbol, asset_class, signal, COUNT(*)::int AS n
                FROM signals ${whereAgg}
                GROUP BY symbol, asset_class, signal
            `, params),
            db.query(`
                SELECT id, symbol, interval, signal, confidence, entry, stop_loss, take_profit,
                       created_at, asset_class, outcome, closed_at, exit_price, pnl_pct
                FROM signals ${whereTrades}
                ORDER BY created_at ASC
            `, params),
        ]);

        // ── Comptes globaux (tous signaux hors LEGACY, HOLD inclus) ──
        const groups = aggRes.rows.map(g => {
            const symbol = normSymbol(g.symbol);
            return { symbol, cls: classifyAsset(symbol, g.asset_class), signal: g.signal, n: g.n };
        });
        if (!groups.length) return res.json(emptyAnalytics(filterClass));

        // ── Trades BUY/SELL, dédupliqués ──
        const allTrades = dedupeTrades(tradeRes.rows.map(r => {
            const symbol = normSymbol(r.symbol);
            return {
                ...r,
                symbol,
                cls:        classifyAsset(symbol, r.asset_class),
                confidence: r.confidence || 0,
                entry:      parseFloat(r.entry),
                exit_price: r.exit_price != null ? parseFloat(r.exit_price) : null,
                pnl_pct:    r.pnl_pct != null ? parseFloat(r.pnl_pct) : null,
                created_at: new Date(r.created_at),
                closed_at:  r.closed_at ? new Date(r.closed_at) : null,
            };
        }));

        // ── Drill-down: tout sauf Attribution suit la classe choisie ──
        const fg     = filterClass ? groups.filter(g => g.cls === filterClass) : groups;
        const trades = filterClass ? allTrades.filter(t => t.cls === filterClass) : allTrades;
        if (!fg.length) return res.json(emptyAnalytics(filterClass));

        const total = fg.reduce((a, g) => a + g.n, 0);
        const buys  = fg.filter(g => g.signal === 'BUY').reduce((a, g) => a + g.n, 0);
        const sells = fg.filter(g => g.signal === 'SELL').reduce((a, g) => a + g.n, 0);
        const holds = total - buys - sells;
        const uniqueSymbols = new Set(fg.map(g => g.symbol)).size;
        const classesPresent = [...new Set(fg.map(g => g.cls))];

        // ── Stats sur trades CLOS uniquement ──
        const resolved        = trades.filter(isResolved);
        const resolvedByClose = resolved.slice().sort((a, b) => a.closed_at - b.closed_at);
        const openCount       = trades.length - resolved.length;
        const S               = summarize(resolved);
        const rrReal          = realizedRR(S);
        const low             = resolved.length < MIN_SAMPLE;

        // Equity (somme des %) + max drawdown
        let cum = 0, peak = 0, maxDD = 0;
        const equity = resolvedByClose.map(t => {
            cum += t.pnl_pct;
            if (cum > peak) peak = cum;
            maxDD = Math.max(maxDD, peak - cum);
            return { day: dayLabel(t.closed_at), portfolio: r2(100 + cum), pnl: r2(t.pnl_pct) };
        });

        const pfValue = S.profitFactor == null ? '—' : S.profitFactor === Infinity ? '∞' : S.profitFactor.toFixed(2);
        const pfColor = S.profitFactor == null ? 'var(--cyan)' : S.profitFactor >= 1 ? 'var(--green)' : 'var(--red)';
        const expColor = S.expectancy == null ? 'var(--cyan)' : S.expectancy >= 0 ? 'var(--green)' : 'var(--red)';

        const kpis = [
            { label: 'Signaux', v: total.toString(),
              sub: `${buys} BUY · ${sells} SELL · ${holds} HOLD`, color: 'var(--cyan)' },
            { label: 'Win Rate', v: resolved.length ? S.winRate.toFixed(1) + '%' : '—',
              sub: `${S.wins}/${resolved.length} clos · ${openCount} ouverts`,
              color: low ? 'var(--amber)' : 'var(--green)' },
            { label: 'Profit Factor', v: pfValue,
              sub: 'gains bruts / pertes brutes', color: pfColor },
            { label: 'Expectancy', v: S.expectancy == null ? '—' : sgn(S.expectancy),
              sub: 'gain moyen par trade', color: expColor },
            { label: 'Max Drawdown', v: resolved.length ? `-${maxDD.toFixed(2)}%` : '—',
              sub: 'pic → creux (cumul des trades)', color: maxDD > 0 ? 'var(--red)' : 'var(--cyan)' },
        ];

        const distribution = { buy: buys, sell: sells, hold: holds, total };

        // ── Rendements mensuels (par date de clôture) ──
        const monthMap = {};
        resolvedByClose.forEach(t => {
            const key = monthLabel(t.closed_at);
            const m = monthMap[key] || (monthMap[key] = { sum: 0, count: 0, wins: 0 });
            m.sum += t.pnl_pct; m.count++; if (t.pnl_pct > 0) m.wins++;
        });
        const monthly = Object.entries(monthMap).map(([month, v]) => ({
            month, ret: r2(v.sum), count: v.count, winRate: Math.round((v.wins / v.count) * 100),
        }));

        // ── Journal: derniers trades BUY/SELL (la page affiche 10 par page) ──
        const journal = trades.slice().reverse().slice(0, JOURNAL_LIMIT).map(t => {
            const done = isResolved(t);
            return {
                date:        t.created_at.toISOString().slice(0, 10),
                sym:         t.symbol,
                asset_class: t.cls,
                side:        t.signal === 'BUY' ? 'Long' : 'Short',
                entry:       fmtPrice(t.entry),
                exit:        done ? fmtPrice(t.exit_price) : '—',
                pnl:         done ? `${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(2)}%` : 'OPEN',
                duration:    done && t.closed_at ? fmtDuration(t.closed_at - t.created_at) : '—',
                outcome:     done ? t.outcome : 'OPEN',
            };
        });

        // ── Attribution: toujours sur TOUTES les classes (menu de navigation) ──
        const classAgg = {};
        groups.forEach(g => {
            const c = classAgg[g.cls] || (classAgg[g.cls] = { total: 0, confSum: 0, confN: 0 });
            c.total += g.n;
        });
        allTrades.forEach(t => {
            const c = classAgg[t.cls] || (classAgg[t.cls] = { total: 0, confSum: 0, confN: 0 });
            c.confSum += t.confidence; c.confN++;
        });
        const allTotal    = groups.reduce((a, g) => a + g.n, 0);
        const allResolved = allTrades.filter(isResolved);
        const attribution = Object.entries(classAgg).map(([name, v]) => {
            const rs = allResolved.filter(t => t.cls === name);
            const s  = summarize(rs);
            return {
                name,
                total:   v.total,
                pct:     parseFloat(((v.total / allTotal) * 100).toFixed(1)),
                closed:  rs.length,
                winRate: s.winRate == null ? null : parseFloat(s.winRate.toFixed(1)),
                // confidence moyenne des TRADES (BUY/SELL), pas des HOLD
                avgConf: v.confN ? Math.round(v.confSum / v.confN) : null,
                avgRR:   parseFloat(realizedRR(s).toFixed(2)),
                color:   COLORS[name] || 'var(--cyan)',
            };
        }).sort((a, b) => b.total - a.total);

        // ── Win rate par jour de la semaine (jour d'ENTRÉE, UTC) ──
        const dowMap = Object.fromEntries(DOW_ORDER.map(d => [d, { win: 0, total: 0, sell: 0 }]));
        resolved.forEach(t => {
            const m = dowMap[getDow(t.created_at)];
            m.total++;
            if (t.pnl_pct > 0) m.win++;
            if (t.signal === 'SELL') m.sell++;
        });
        const byDow = DOW_ORDER.map(day => {
            const m = dowMap[day];
            return {
                day, total: m.total,
                winRate: m.total ? parseFloat(((m.win / m.total) * 100).toFixed(1)) : 0,
                buy: m.total - m.sell, sell: m.sell,
            };
        });

        // ── Win rate glissant: fenêtre de 30 TRADES clos ──
        const WINDOW = 30;
        const rollingRaw = resolvedByClose.map((t, i) => {
            const w = resolvedByClose.slice(Math.max(0, i - WINDOW + 1), i + 1);
            const ww = w.filter(x => x.pnl_pct > 0).length;
            return { day: dayLabel(t.closed_at), winRate: parseFloat(((ww / w.length) * 100).toFixed(1)), count: w.length };
        });
        const rolling = Object.values(rollingRaw.reduce((acc, r) => { acc[r.day] = r; return acc; }, {}));

        // ── Win rate par tranche de confidence (remplace la corrélation de Pearson) ──
        const confidenceBuckets = CONF_BUCKETS.map(b => {
            const list = resolved.filter(t => t.confidence >= b.min && t.confidence < b.max);
            const s = summarize(list);
            return {
                range:   b.label,
                n:       list.length,
                winRate: s.winRate == null ? null : parseFloat(s.winRate.toFixed(1)),
                avgPnl:  s.expectancy == null ? null : r2(s.expectancy),
            };
        });

        // ── Métriques de performance ──
        const durations = resolved.filter(t => t.closed_at).map(t => t.closed_at - t.created_at);
        const best  = resolved.length ? Math.max(...resolved.map(t => t.pnl_pct)) : null;
        const worst = resolved.length ? Math.min(...resolved.map(t => t.pnl_pct)) : null;
        const metrics = [
            { label: 'Avg Confidence',  value: trades.length ? Math.round(avg(trades.map(t => t.confidence))) + '%' : '—',
              hint: 'trades BUY/SELL (HOLD exclus)' },
            { label: 'R:R réalisé',     value: rrReal > 0 ? `1:${rrReal.toFixed(2)}` : '—',
              hint: 'gain moyen / perte moyenne' },
            { label: 'Gain moyen',      value: S.avgWin > 0 ? sgn(S.avgWin) : '—',  tone: 'pos', hint: 'trades gagnants' },
            { label: 'Perte moyenne',   value: S.avgLoss > 0 ? `-${S.avgLoss.toFixed(2)}%` : '—', tone: 'neg', hint: 'trades perdants' },
            { label: 'Meilleur trade',  value: best  == null ? '—' : sgn(best),  tone: best  > 0 ? 'pos' : undefined },
            { label: 'Pire trade',      value: worst == null ? '—' : sgn(worst), tone: worst < 0 ? 'neg' : undefined },
            { label: 'Durée moyenne',   value: durations.length ? fmtDuration(avg(durations)) : '—', hint: 'entrée → clôture' },
            { label: 'Actifs suivis',   value: String(uniqueSymbols), hint: classesPresent.join(' · ') },
        ];

        res.json({
            success: true, kpis, equity, monthly, trades: journal, attribution, byDow,
            rolling, metrics, confidenceBuckets, distribution,
            sample: { closed: resolved.length, open: openCount, min: MIN_SAMPLE, low },
            selectedClass: filterClass || null,
        });

    } catch (err) {
        logger.error(`[analytics] ${err.message}`);
        res.status(500).json({ success: false, error: 'Analytics unavailable' });
    }
}

module.exports = {
    getAllSignals,
    getScanStatus,
    getSignalBySymbol,
    getSupportedSymbols,
    getAlphaEngineData,
    getAnalyticsData,
};