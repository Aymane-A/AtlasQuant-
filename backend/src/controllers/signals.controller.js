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

// ── analytics helpers ─────────────────────────────────────
const PERIOD_DAYS = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
const WEEK_MS     = 7 * 86400000;
const DOW_LABELS  = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
const DOW_ORDER   = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
const COLORS = {
    Crypto:    'var(--cyan)',
    Forex:     'var(--purple-bright)',
    Commodity: 'var(--amber)',
    Indices:   'var(--green)',
    Equity:    'var(--red)',
};

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

// Tout en UTC: journal, heatmap DoW, labels — plus de décalage de timezone
const dayLabel   = d => new Date(d).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: '2-digit', month: 'short' });
const monthLabel = d => new Date(d).toLocaleString('fr-FR',      { timeZone: 'UTC', month: 'short', year: 'numeric' });
const getDow     = d => DOW_LABELS[new Date(d).getUTCDay()];

const avg   = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2    = n => Math.round(n * 100) / 100;
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

const isResolved = t => t.pnl_pct != null && ['TP', 'SL', 'EXPIRED'].includes(t.outcome);

function realizedRR(list) {
    const wins   = list.filter(t => t.pnl_pct > 0).map(t => t.pnl_pct);
    const losses = list.filter(t => t.pnl_pct < 0).map(t => Math.abs(t.pnl_pct));
    return wins.length && losses.length ? avg(wins) / avg(losses) : 0;
}

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

function pearsonCorrelation(points) {
    const n = points.length;
    if (n < 2) return 0;
    const xs = points.map(p => p.confidence);
    const ys = points.map(p => p.pnl);
    const mx = avg(xs), my = avg(ys);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
    }
    const den = Math.sqrt(dx2 * dy2);
    return den > 0 ? num / den : 0;
}

const emptyAnalytics = filterClass => ({
    success: true, kpis: [], equity: [], monthly: [], trades: [],
    attribution: [], byDow: [], rolling: [], fingerprint: [],
    distribution: { buy: 0, sell: 0, hold: 0, total: 0 },
    confidenceOutcome: [], confidenceCorrelation: 0,
    selectedClass: filterClass || null,
});

// ── getAnalyticsData ──────────────────────────────────────
// Perf: les HOLD (~90% des lignes) ne sont JAMAIS chargés en JS — on les
// compte via un GROUP BY SQL. Seuls les BUY/SELL sont lus ligne par ligne.
// P&L: vient de signals.pnl_pct (rempli par outcomeResolver.service.js),
// plus aucune formule basée sur la confidence.
async function getAnalyticsData(req, res) {
    try {
        const { period, class: filterClass } = req.query;
        const days   = PERIOD_DAYS[period];
        const where  = days ? `WHERE created_at >= NOW() - make_interval(days => $1::int)` : '';
        const params = days ? [days] : [];

        const [aggRes, tradeRes] = await Promise.all([
            db.query(`
                SELECT symbol, asset_class, signal,
                       COUNT(*)::int AS n,
                       COALESCE(SUM(confidence), 0)::float AS conf_sum
                FROM signals ${where}
                GROUP BY symbol, asset_class, signal
            `, params),
            db.query(`
                SELECT id, symbol, interval, signal, confidence, entry, stop_loss, take_profit,
                       created_at, asset_class, outcome, closed_at, exit_price, pnl_pct
                FROM signals
                ${where ? where + ' AND' : 'WHERE'} signal IN ('BUY','SELL')
                  AND COALESCE(outcome, '') NOT IN ('INVALID', 'LEGACY')
                ORDER BY created_at ASC
            `, params),
        ]);

        // ── Comptes globaux (tous signaux, HOLD inclus) ──
        const groups = aggRes.rows.map(g => {
            const symbol = normSymbol(g.symbol);
            return { symbol, cls: classifyAsset(symbol, g.asset_class), signal: g.signal, n: g.n, confSum: g.conf_sum };
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
        const avgConf = Math.round(fg.reduce((a, g) => a + g.confSum, 0) / total);
        const uniqueSymbols = new Set(fg.map(g => g.symbol)).size;

        // ── Stats sur trades CLOS uniquement ──
        const resolved        = trades.filter(isResolved);
        const resolvedByClose = resolved.slice().sort((a, b) => a.closed_at - b.closed_at);
        const openCount       = trades.length - resolved.length;
        const wins            = resolved.filter(t => t.pnl_pct > 0).length;
        const winRate         = resolved.length ? (wins / resolved.length) * 100 : 0;
        const rrReal          = realizedRR(resolved);

        const kpis = [
            { label: 'Total Signals',  v: total.toString(),
              sub: `${buys} BUY · ${sells} SELL · ${holds} HOLD`, color: 'var(--cyan)' },
            { label: 'Win Rate',       v: resolved.length ? winRate.toFixed(1) + '%' : '—',
              sub: `${wins}/${resolved.length} clos · ${openCount} ouverts`, color: 'var(--green)' },
            { label: 'Avg Confidence', v: avgConf + '%',
              sub: 'Moyenne IA', color: 'var(--amber)' },
            { label: 'Avg R:R',        v: rrReal > 0 ? `1:${rrReal.toFixed(2)}` : '—',
              sub: 'R:R réalisé (TP/SL)', color: 'var(--cyan)' },
            { label: 'Actifs',         v: uniqueSymbols.toString(),
              sub: 'Crypto · Forex · Commo · Indices', color: 'var(--purple-bright)' },
        ];

        const distribution = { buy: buys, sell: sells, hold: holds, total };

        // ── Equity: somme des P&L par trade, classée par date de CLÔTURE ──
        let cum = 0;
        const equity = resolvedByClose.map(t => {
            cum += t.pnl_pct;
            return { day: dayLabel(t.closed_at), portfolio: r2(100 + cum), pnl: r2(t.pnl_pct) };
        });

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

        // ── Journal: 10 derniers trades BUY/SELL (les HOLD n'en sont pas) ──
        const journal = trades.slice().reverse().slice(0, 10).map(t => {
            const done = isResolved(t);
            const entry = parseFloat(t.entry), sl = parseFloat(t.stop_loss), tp = parseFloat(t.take_profit);
            const risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
            return {
                date:        t.created_at.toISOString().slice(0, 10),
                sym:         t.symbol,
                asset_class: t.cls,
                side:        t.signal === 'BUY' ? 'Long' : 'Short',
                pnl:         done ? `${t.pnl_pct >= 0 ? '+' : ''}${t.pnl_pct.toFixed(2)}%` : 'OPEN',
                rr:          risk > 0 ? `1:${(reward / risk).toFixed(1)}` : '—',
                outcome:     done ? t.outcome : 'OPEN',
            };
        });

        // ── Attribution: toujours sur TOUTES les classes (menu de navigation) ──
        const classAgg = {};
        groups.forEach(g => {
            const c = classAgg[g.cls] || (classAgg[g.cls] = { total: 0, confSum: 0 });
            c.total += g.n; c.confSum += g.confSum;
        });
        const allTotal    = groups.reduce((a, g) => a + g.n, 0);
        const allResolved = allTrades.filter(isResolved);
        const attribution = Object.entries(classAgg).map(([name, v]) => {
            const rs = allResolved.filter(t => t.cls === name);
            const w  = rs.filter(t => t.pnl_pct > 0).length;
            return {
                name,
                total:   v.total,
                pct:     parseFloat(((v.total / allTotal) * 100).toFixed(1)),
                closed:  rs.length,
                winRate: rs.length ? parseFloat(((w / rs.length) * 100).toFixed(1)) : null,
                avgConf: Math.round(v.confSum / v.total),
                avgRR:   parseFloat(realizedRR(rs).toFixed(2)),
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

        // ── Fingerprint: 6 métriques toutes calculées sur des trades clos/réels ──
        // Consistance = stabilité du win rate d'une semaine à l'autre (>=3 trades/semaine)
        const weekMap = {};
        resolved.forEach(t => {
            const k = Math.floor(t.closed_at.getTime() / WEEK_MS);
            const w = weekMap[k] || (weekMap[k] = { n: 0, win: 0 });
            w.n++; if (t.pnl_pct > 0) w.win++;
        });
        const weekRates = Object.values(weekMap).filter(w => w.n >= 3).map(w => (w.win / w.n) * 100);
        let consistency = 0;
        if (weekRates.length >= 2) {
            const m = avg(weekRates);
            const sd = Math.sqrt(avg(weekRates.map(x => (x - m) ** 2)));
            consistency = clamp(100 - (sd / 30) * 100);
        }

        // Diversification = 1 - HHI, normalisé sur 5 classes
        const clsCount = {};
        trades.forEach(t => { clsCount[t.cls] = (clsCount[t.cls] || 0) + 1; });
        const hhi = trades.length ? Object.values(clsCount).reduce((a, n) => a + (n / trades.length) ** 2, 0) : 1;
        const diversification = trades.length ? clamp(((1 - hhi) / (1 - 1 / 5)) * 100) : 0;

        // Activité = trades (dédupliqués) par jour
        const span = trades.length > 1
            ? Math.max(1, (trades[trades.length - 1].created_at - trades[0].created_at) / 86400000) : 1;
        const tpd = trades.length / span;
        const activity = tpd < 1 ? tpd * 100 : tpd <= 6 ? 100 : Math.max(30, 100 - (tpd - 6) * 10);

        const fingerprint = [
            { metric: 'Win Rate',        value: r2(winRate),                         max: 100 },
            { metric: 'Avg Confidence',  value: r2(avgConf),                         max: 100 },
            { metric: 'Risk/Reward',     value: r2(clamp((rrReal / 3) * 100)),       max: 100 },
            { metric: 'Consistance',     value: r2(consistency),                     max: 100 },
            { metric: 'Diversification', value: r2(diversification),                 max: 100 },
            { metric: 'Activité',        value: r2(clamp(activity)),                 max: 100 },
        ];

        // ── Confidence vs Outcome (maintenant vraiment informatif) ──
        const confidenceOutcome = resolved.map(t => ({
            confidence: t.confidence,
            pnl:        r2(t.pnl_pct),
            signal:     t.signal,
            symbol:     t.symbol,
        }));
        const confidenceCorrelation = parseFloat(pearsonCorrelation(confidenceOutcome).toFixed(2));

        res.json({
            success: true, kpis, equity, monthly, trades: journal, attribution, byDow,
            rolling, fingerprint, distribution,
            confidenceOutcome, confidenceCorrelation,
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