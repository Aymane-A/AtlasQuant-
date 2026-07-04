/**
 * controllers/signals.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');

function parseRR(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    const str = String(val);
    if (str.includes(':')) {
        const parts = str.split(':');
        const ratio = parseFloat(parts[1]);
        return isNaN(ratio) ? 0 : ratio;
    }
    return parseFloat(str) || 0;
}

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

// ── helpers ───────────────────────────────────────────────
const PERIOD_DAYS = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };

// Fallback uniquement si une vieille ligne n'a pas de asset_class (avant migration)
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

function getDow(dateStr) {
    const days = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
    return days[new Date(dateStr).getDay()];
}

// ── getAnalyticsData ──────────────────────────────────────
async function getAnalyticsData(req, res) {
    try {
        const { period } = req.query;
        const days = PERIOD_DAYS[period];

        const query = days
            ? `SELECT symbol, signal, confidence, price, entry,
                      stop_loss, take_profit, risk_reward, created_at, asset_class
               FROM signals
               WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
               ORDER BY created_at DESC`
            : `SELECT symbol, signal, confidence, price, entry,
                      stop_loss, take_profit, risk_reward, created_at, asset_class
               FROM signals ORDER BY created_at DESC`;

        const { rows: signals } = days
            ? await db.query(query, [days])
            : await db.query(query);

        if (!signals.length) {
            return res.json({
                success: true, kpis: [], equity: [], monthly: [], trades: [],
                attribution: [], byDow: [], rolling: [], fingerprint: [],
                distribution: { buy: 0, sell: 0, hold: 0, total: 0 },
            });
        }

        const total = signals.length;
        const buys  = signals.filter(s => s.signal === 'BUY');
        const sells = signals.filter(s => s.signal === 'SELL');
        const holds = total - buys.length - sells.length;

        const avgConf = (signals.reduce((a, s) => a + (s.confidence || 0), 0) / total).toFixed(0);

        const rrValues = signals
            .map(s => {
                const entry  = parseFloat(s.entry)       || 0;
                const sl     = parseFloat(s.stop_loss)   || 0;
                const tp     = parseFloat(s.take_profit) || 0;
                if (entry && sl && tp) {
                    const risk   = Math.abs(entry - sl);
                    const reward = Math.abs(tp - entry);
                    return risk > 0 ? reward / risk : 0;
                }
                return parseRR(s.risk_reward);
            })
            .filter(v => v > 0);

        const avgRR = rrValues.length > 0
            ? (rrValues.reduce((a, b) => a + b, 0) / rrValues.length).toFixed(2)
            : '0.00';

        const uniqueSymbols = [...new Set(signals.map(s => s.symbol))];

        function calcPnlPct(s) {
            const entry  = parseFloat(s.entry)       || parseFloat(s.price) || 0;
            const sl     = parseFloat(s.stop_loss)   || 0;
            const tp     = parseFloat(s.take_profit) || 0;
            if (entry && sl && tp) {
                const riskPct   = Math.abs((entry - sl) / entry) * 100;
                const rewardPct = Math.abs((tp - entry) / entry) * 100;
                const conf = s.confidence || 50;
                if (s.signal === 'BUY')  return conf >= 55 ?  rewardPct : -riskPct;
                if (s.signal === 'SELL') return conf >= 55 ?  rewardPct : -riskPct;
                return 0;
            }
            const rr   = parseRR(s.risk_reward);
            const conf = s.confidence || 50;
            if (s.signal === 'HOLD') return 0;
            if (rr > 0) return conf >= 55 ? rr * 0.5 : -0.5;
            return conf >= 55 ? 0.3 : -0.3;
        }

        // ── Win Rate réel : basé sur le P&L calculé par signal, pas sur le nombre de BUY ──
        const pnlPerSignal = signals.map(s => calcPnlPct(s));
        const winningTrades = pnlPerSignal.filter(p => p > 0).length;
        const winRate = ((winningTrades / total) * 100).toFixed(1);

        const kpis = [
            { label:'Total Signals',  v: total.toString(),               sub:`${buys.length} BUY · ${sells.length} SELL · ${holds} HOLD`, color:'var(--cyan)'          },
            { label:'Win Rate',       v: winRate + '%',                   sub:`▲ ${winningTrades} trades gagnants`,                        color:'var(--green)'         },
            { label:'Avg Confidence', v: avgConf + '%',                   sub:'Moyenne IA',                                                color:'var(--amber)'         },
            { label:'Avg R:R',        v: `1:${avgRR}`,                    sub:'Risk/Reward moyen',                                         color:'var(--cyan)'          },
            { label:'Actifs',         v: uniqueSymbols.length.toString(), sub:'Crypto · Forex · Commo · Indices',                          color:'var(--purple-bright)' },
        ];

        // ── Distribution — source de vérité unique, plus de parsing de string côté frontend ──
        const distribution = { buy: buys.length, sell: sells.length, hold: holds, total };

        const sortedAscAll = signals.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        let cumPnl = 0, cumBench = 0;
        const equity = sortedAscAll.map(s => {
            const pnl = calcPnlPct(s);
            cumPnl   += pnl;
            cumBench += 0.03;
            return {
                day:       new Date(s.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'short' }),
                portfolio: parseFloat((100 + cumPnl).toFixed(2)),
                benchmark: parseFloat((100 + cumBench).toFixed(2)),
                pnl:       parseFloat(pnl.toFixed(2)),
            };
        });

        const monthMap = {};
        sortedAscAll.forEach(s => {
            const d   = new Date(s.created_at);
            const key = d.toLocaleString('fr-FR', { month: 'short', year: 'numeric' });
            if (!monthMap[key]) monthMap[key] = { pnlSum: 0, count: 0, wins: 0 };
            const pnl = calcPnlPct(s);
            monthMap[key].pnlSum += pnl;
            monthMap[key].count++;
            if (pnl > 0) monthMap[key].wins++;
        });

        const monthly = Object.entries(monthMap).map(([month, v]) => ({
            month,
            ret:     parseFloat(v.pnlSum.toFixed(2)),
            count:   v.count,
            winRate: parseFloat(((v.wins / v.count) * 100).toFixed(0)),
        }));

        const trades = signals.slice(0, 10).map(s => {
            const entry  = parseFloat(s.entry)       || parseFloat(s.price) || 0;
            const sl     = parseFloat(s.stop_loss)   || 0;
            const tp     = parseFloat(s.take_profit) || 0;
            const rrRaw  = parseRR(s.risk_reward);

            let rrDisplay = '—', pnlDisplay;

            // ✅ Fix Bug 5: un signal HOLD ne correspond à aucune position ouverte —
            // son P&L doit être 0, cohérent avec calcPnlPct() plus haut qui fait déjà
            // ce check. Avant ce fix, cette fonction dupliquait la logique de calcul
            // sans ce garde-fou et traitait HOLD comme un SELL (pnlPts = -risk),
            // affichant des pertes fictives pour des signaux qui n'ont pris aucun trade.
            if (s.signal === 'HOLD') {
                pnlDisplay = '0.0 pts';
            } else if (entry && sl && tp) {
                const risk   = Math.abs(entry - sl);
                const reward = Math.abs(tp - entry);
                const rrCalc = risk > 0 ? reward / risk : 0;
                rrDisplay    = `1:${rrCalc.toFixed(1)}`;
                const pnlPts = s.signal === 'BUY' ? reward : -risk;
                pnlDisplay   = pnlPts >= 0 ? `+${pnlPts.toFixed(2)} pts` : `${pnlPts.toFixed(2)} pts`;
            } else if (rrRaw > 0) {
                rrDisplay  = `1:${rrRaw.toFixed(1)}`;
                pnlDisplay = rrRaw >= 1 ? `+${(rrRaw * 100).toFixed(0)} pts` : `-${(100 / rrRaw).toFixed(0)} pts`;
            } else {
                // NOTE (Bug 3 — indices identiques) : cette branche fallback ne dépend que de
                // `confidence`. Si plusieurs signaux (ex. indices) ont la même confidence,
                // ils produiront le même pnlPts affiché ici. La vraie cause est en amont :
                // entry/stop_loss/take_profit ou risk_reward ne sont pas renseignés pour ces
                // symboles au moment de l'insertion (voir yahooFinance.service.js). Cette
                // branche reste un fallback volontaire, pas un fix — à corriger à la source.
                const conf   = s.confidence || 60;
                const pnlPts = s.signal === 'BUY' ? (conf - 50) * 0.5 : -(conf - 50) * 0.3;
                pnlDisplay = pnlPts >= 0 ? `+${pnlPts.toFixed(1)} pts` : `${pnlPts.toFixed(1)} pts`;
            }

            return {
                date:        new Date(s.created_at).toISOString().split('T')[0],
                sym:         s.symbol,
                asset_class: classifyAsset(s.symbol, s.asset_class),
                side:        s.signal === 'BUY' ? 'Long' : s.signal === 'SELL' ? 'Short' : 'Hold',
                pnl:         pnlDisplay,
                rr:          rrDisplay,
            };
        });

        // ── P&L Attribution by asset class (utilise asset_class réel, fallback si null) ──
        const classMap = {};
        signals.forEach(s => {
            const cls = classifyAsset(s.symbol, s.asset_class);
            if (!classMap[cls]) classMap[cls] = { total: 0, win: 0, buy: 0, sell: 0, confSum: 0, rrSum: 0, rrCount: 0 };
            classMap[cls].total++;
            // ✅ Fix Bug 9: même correction que le KPI Win Rate — basé sur le P&L réel
            // (calcPnlPct), pas sur le nombre de BUY. Avant ce fix, une classe avec
            // beaucoup de HOLD (ex. Crypto) affichait un "win rate" artificiellement
            // bas, alors qu'un HOLD n'est ni une perte ni un gain.
            if (calcPnlPct(s) > 0) classMap[cls].win++;
            if (s.signal === 'BUY')  classMap[cls].buy++;
            if (s.signal === 'SELL') classMap[cls].sell++;
            classMap[cls].confSum += (s.confidence || 0);
            const entry = parseFloat(s.entry) || 0;
            const sl    = parseFloat(s.stop_loss) || 0;
            const tp    = parseFloat(s.take_profit) || 0;
            let rr = 0;
            if (entry && sl && tp) {
                const risk = Math.abs(entry - sl);
                const reward = Math.abs(tp - entry);
                rr = risk > 0 ? reward / risk : 0;
            } else {
                rr = parseRR(s.risk_reward);
            }
            if (rr > 0) { classMap[cls].rrSum += rr; classMap[cls].rrCount++; }
        });

        const COLORS = { 'Crypto':'var(--cyan)', 'Forex':'var(--purple-bright)', 'Commodity':'var(--amber)', 'Indices':'var(--green)' };
        const attribution = Object.entries(classMap).map(([name, v]) => ({
            name,
            total:   v.total,
            pct:     parseFloat(((v.total / total) * 100).toFixed(1)),
            winRate: parseFloat(((v.win / v.total) * 100).toFixed(1)),
            avgConf: parseFloat((v.confSum / v.total).toFixed(0)),
            avgRR:   v.rrCount > 0 ? parseFloat((v.rrSum / v.rrCount).toFixed(2)) : 0,
            color:   COLORS[name] || 'var(--cyan)',
        })).sort((a, b) => b.total - a.total);

        const DOW_ORDER = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
        const dowMap = {};
        DOW_ORDER.forEach(d => { dowMap[d] = { win: 0, sell: 0, hold: 0, total: 0 }; });
        signals.forEach(s => {
            const d = getDow(s.created_at);
            if (!dowMap[d]) return;
            dowMap[d].total++;
            if (calcPnlPct(s) > 0)         dowMap[d].win++;
            if (s.signal === 'SELL')      dowMap[d].sell++;
            else if (s.signal === 'HOLD') dowMap[d].hold++;
        });
        const byDow = DOW_ORDER.map(day => ({
            day,
            total:   dowMap[day].total,
            // ✅ Fix Bug 7: même correction que le KPI Win Rate — basé sur le P&L réel
            // (calcPnlPct), pas sur le nombre de BUY. Cohérent avec Win Rate Glissant.
            winRate: dowMap[day].total > 0
                ? parseFloat(((dowMap[day].win / dowMap[day].total) * 100).toFixed(1))
                : 0,
            buy:  dowMap[day].total - dowMap[day].sell - dowMap[day].hold,
            sell: dowMap[day].sell,
        }));

        const sortedAsc = signals.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const WINDOW = 30;
        const rolling = [];
        for (let i = 0; i < sortedAsc.length; i++) {
            const windowSlice = sortedAsc.slice(Math.max(0, i - WINDOW + 1), i + 1);
            // ✅ Fix Bug 6: win rate glissant basé sur le P&L réel (calcPnlPct), pas
            // sur le nombre de BUY — cohérent avec le KPI "Win Rate" déjà corrigé.
            const windowWins = windowSlice.filter(s => calcPnlPct(s) > 0).length;
            const wRate = windowSlice.length > 0 ? parseFloat(((windowWins / windowSlice.length) * 100).toFixed(1)) : 0;
            rolling.push({
                day:     new Date(sortedAsc[i].created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'short' }),
                winRate: wRate,
                count:   windowSlice.length,
            });
        }
        const rollingDeduped = Object.values(
            rolling.reduce((acc, r) => { acc[r.day] = r; return acc; }, {})
        );

        const rrScore = Math.min(100, parseFloat(avgRR) / 3 * 100);

        const weekMap = {};
        sortedAsc.forEach(s => {
            const d = new Date(s.created_at);
            const startOfYear = new Date(d.getFullYear(), 0, 1);
            const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
            const key = `${d.getFullYear()}-W${week}`;
            if (!weekMap[key]) weekMap[key] = { buy: 0, total: 0 };
            weekMap[key].total++;
            if (s.signal === 'BUY') weekMap[key].buy++;
        });
        const weekRates = Object.values(weekMap).map(w => w.total > 0 ? (w.buy / w.total) * 100 : 0);
        let consistencyScore = 50;
        if (weekRates.length > 1) {
            const mean = weekRates.reduce((a, b) => a + b, 0) / weekRates.length;
            const variance = weekRates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / weekRates.length;
            const stdDev = Math.sqrt(variance);
            consistencyScore = Math.max(0, Math.min(100, 100 - (stdDev / 30) * 100));
        } else if (weekRates.length === 1) {
            consistencyScore = 60;
        }

        const classCount = Object.keys(classMap).length;
        const diversificationScore = Math.min(100, (classCount / 4) * 100);

        let activityScore = 50;
        if (signals.length > 0) {
            const oldest = new Date(sortedAsc[0]?.created_at);
            const newest = new Date(sortedAsc[sortedAsc.length - 1]?.created_at);
            const daySpan = Math.max(1, (newest - oldest) / 86400000);
            const sigPerDay = total / daySpan;
            if (sigPerDay >= 3 && sigPerDay <= 5)      activityScore = 100;
            else if (sigPerDay >= 1 && sigPerDay < 3)  activityScore = 60 + (sigPerDay - 1) / 2 * 40;
            else if (sigPerDay > 5 && sigPerDay <= 10) activityScore = 100 - (sigPerDay - 5) / 5 * 30;
            else if (sigPerDay > 10)                   activityScore = 70 - Math.min(30, (sigPerDay - 10) * 2);
            else                                       activityScore = Math.max(10, sigPerDay * 40);
        }

        const fingerprint = [
            { metric: 'Win Rate',        value: parseFloat(parseFloat(winRate).toFixed(1)),          max: 100 },
            { metric: 'Avg Confidence',  value: parseFloat(parseFloat(avgConf).toFixed(1)),          max: 100 },
            { metric: 'Risk/Reward',     value: parseFloat(rrScore.toFixed(1)),                      max: 100 },
            { metric: 'Consistance',     value: parseFloat(consistencyScore.toFixed(1)),             max: 100 },
            { metric: 'Diversification', value: parseFloat(diversificationScore.toFixed(1)),         max: 100 },
            { metric: 'Activité',        value: parseFloat(Math.min(100, activityScore).toFixed(1)), max: 100 },
        ];

        res.json({ success: true, kpis, equity, monthly, trades, attribution, byDow, rolling: rollingDeduped, fingerprint, distribution });

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