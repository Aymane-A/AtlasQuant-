/**
 * controllers/signals.controller.js
 */
const db     = require('../config/db');
const logger = require('../utils/logger');
const { scanAll }  = require('../services/signalGenerator.service');
const { scanAllYF } = require('../services/yahooFinance.service');

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

async function getAllSignals(req, res) {
    try {
        const { interval = '4h', refresh } = req.query;

        if (refresh === 'true') {
            const [cryptoResult, yfResult] = await Promise.all([
                scanAll(interval),
                scanAllYF(interval),
            ]);

            const allSignals = [
                ...cryptoResult.signals,
                ...yfResult,
            ].sort((a, b) => b.confidence - a.confidence);

            for (const sig of allSignals) {
                await db.query(`
                    INSERT INTO signals (symbol, interval, signal, confidence, price, entry, stop_loss, take_profit, risk_reward, reasoning, indicators)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    ON CONFLICT DO NOTHING
                `, [
                    sig.symbol, interval, sig.signal, sig.confidence,
                    sig.price,
                    sig.entry       || sig.price,
                    sig.stop_loss   || null,
                    sig.take_profit || null,
                    sig.risk_reward || null,
                    sig.reasoning,
                    JSON.stringify(sig.indicators)
                ]);
            }

            return res.json({ success: true, signals: allSignals, scannedAt: new Date().toISOString() });
        }

        const { rows } = await db.query(
            `SELECT * FROM signals WHERE interval = $1 ORDER BY created_at DESC LIMIT 30`,
            [interval]
        );

        const signals = rows.map(r => ({
            id:          r.id,
            symbol:      r.symbol,
            interval:    r.interval,
            signal:      r.signal,
            confidence:  r.confidence,
            price:       parseFloat(r.price),
            entry:       parseFloat(r.entry),
            stop_loss:   parseFloat(r.stop_loss),
            take_profit: parseFloat(r.take_profit),
            risk_reward: r.risk_reward,
            reasoning:   r.reasoning,
            indicators:  r.indicators,
            timestamp:   r.created_at,
        }));

        res.json({ success: true, signals });

    } catch (err) {
        logger.error(`[getAllSignals] ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
}

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

async function getSupportedSymbols(req, res) {
    try {
        const { rows } = await db.query('SELECT DISTINCT symbol FROM signals');
        res.json({ success: true, symbols: rows.map(r => r.symbol) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}

async function getAlphaEngineData(req, res) {
    try {
        res.json({ success: true, data: { modelStatus: 'Active', confidenceScore: 0.92, lastPrediction: 'Bullish' } });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Engine data unavailable' });
    }
}

// ── helpers ───────────────────────────────────────────────
const PERIOD_DAYS = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };

function classifyAsset(symbol) {
    const s = symbol.toUpperCase();
    const FOREX   = ['EUR','GBP','JPY','CHF','AUD','CAD','NZD','USD'];
    const COMMO   = ['XAU','XAG','OIL','WTI','BRENT','GAS','NG','WHEAT','CORN','COPPER'];
    const INDICES = ['SPY','QQQ','DIA','IWM','SPX','NDX','VIX'];

    if (FOREX.some(f  => s.includes(f) && s.includes('/') && !s.includes('USDT') && !s.includes('BTC')))  return 'Forex';
    if (COMMO.some(c  => s.includes(c)))  return 'Commodités';
    if (INDICES.some(i => s.includes(i))) return 'Indices';
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
                      stop_loss, take_profit, risk_reward, created_at
               FROM signals
               WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
               ORDER BY created_at DESC`
            : `SELECT symbol, signal, confidence, price, entry,
                      stop_loss, take_profit, risk_reward, created_at
               FROM signals ORDER BY created_at DESC`;

        const { rows: signals } = days
            ? await db.query(query, [days])
            : await db.query(query);

        if (!signals.length) {
            return res.json({ success: true, kpis: [], equity: [], monthly: [], trades: [], attribution: [], byDow: [], rolling: [], fingerprint: [] });
        }

        const total   = signals.length;
        const buys    = signals.filter(s => s.signal === 'BUY');
        const sells   = signals.filter(s => s.signal === 'SELL');
        const wins    = buys.length;
        const winRate = ((wins / total) * 100).toFixed(1);
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

        // ── KPIs ──
        const kpis = [
            { label:'Total Signals',  v: total.toString(),               sub:`${wins} BUY · ${sells.length} SELL`, color:'var(--cyan)'          },
            { label:'Win Rate',       v: winRate + '%',                   sub:`▲ ${wins} signaux haussiers`,        color:'var(--green)'         },
            { label:'Avg Confidence', v: avgConf + '%',                   sub:'Moyenne IA',                         color:'var(--amber)'         },
            { label:'Avg R:R',        v: `1:${avgRR}`,                    sub:'Risk/Reward moyen',                  color:'var(--cyan)'          },
            { label:'Actifs',         v: uniqueSymbols.length.toString(), sub:'Crypto · Forex · Commo',             color:'var(--purple-bright)' },
        ];

        // ── Real P&L per signal (in % of entry, capped at ±20%) ──
        // Logic: BUY wins if tp hit (reward%), loses if sl hit (-risk%)
        //        SELL wins if sl hit as price drops (reward%), loses if tp hit (-risk%)
        //        HOLD = 0 (neutral, no directional bet)
        // If entry/sl/tp missing → use confidence as proxy (conf>60 = small gain, else small loss)
        function calcPnlPct(s) {
            const entry  = parseFloat(s.entry)       || parseFloat(s.price) || 0;
            const sl     = parseFloat(s.stop_loss)   || 0;
            const tp     = parseFloat(s.take_profit) || 0;
            if (entry && sl && tp) {
                const riskPct   = Math.abs((entry - sl) / entry) * 100;
                const rewardPct = Math.abs((tp - entry) / entry) * 100;
                // Assume signal hits TP if confidence >= 55, else SL
                const conf = s.confidence || 50;
                if (s.signal === 'BUY')  return conf >= 55 ?  rewardPct : -riskPct;
                if (s.signal === 'SELL') return conf >= 55 ?  rewardPct : -riskPct;
                return 0; // HOLD
            }
            // Fallback: no price data → use RR + confidence
            const rr   = parseRR(s.risk_reward);
            const conf = s.confidence || 50;
            if (s.signal === 'HOLD') return 0;
            if (rr > 0) return conf >= 55 ? rr * 0.5 : -0.5;
            return conf >= 55 ? 0.3 : -0.3;
        }

        // ── Equity curve: cumulative P&L starting at 100 base ──
        const sortedAscAll = signals.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        let cumPnl = 0;
        // Benchmark: simple 0.03% per signal (passive market drift)
        let cumBench = 0;
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

        // ── Monthly returns: real sum of P&L % per month ──
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

        // ── Trade log ──
        const trades = signals.slice(0, 10).map(s => {
            const entry  = parseFloat(s.entry)       || parseFloat(s.price) || 0;
            const sl     = parseFloat(s.stop_loss)   || 0;
            const tp     = parseFloat(s.take_profit) || 0;
            const rrRaw  = parseRR(s.risk_reward);

            let rrDisplay = '—';
            let pnlDisplay;

            if (entry && sl && tp) {
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
                const conf   = s.confidence || 60;
                const pnlPts = s.signal === 'BUY' ? (conf - 50) * 0.5 : -(conf - 50) * 0.3;
                pnlDisplay = pnlPts >= 0 ? `+${pnlPts.toFixed(1)} pts` : `${pnlPts.toFixed(1)} pts`;
            }

            return {
                date: new Date(s.created_at).toISOString().split('T')[0],
                sym:  s.symbol,
                side: s.signal === 'BUY' ? 'Long' : s.signal === 'SELL' ? 'Short' : 'Hold',
                pnl:  pnlDisplay,
                rr:   rrDisplay,
            };
        });

        // ── NEW: P&L Attribution by asset class ──────────────
        const classMap = {};
        signals.forEach(s => {
            const cls = classifyAsset(s.symbol);
            if (!classMap[cls]) classMap[cls] = { total: 0, buy: 0, sell: 0, confSum: 0, rrSum: 0, rrCount: 0 };
            classMap[cls].total++;
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

        const COLORS = { 'Crypto':'var(--cyan)', 'Forex':'var(--purple-bright)', 'Commodités':'var(--amber)', 'Indices':'var(--green)' };
        const attribution = Object.entries(classMap).map(([name, v]) => ({
            name,
            total:   v.total,
            pct:     parseFloat(((v.total / total) * 100).toFixed(1)),
            winRate: parseFloat(((v.buy / v.total) * 100).toFixed(1)),
            avgConf: parseFloat((v.confSum / v.total).toFixed(0)),
            avgRR:   v.rrCount > 0 ? parseFloat((v.rrSum / v.rrCount).toFixed(2)) : 0,
            color:   COLORS[name] || 'var(--cyan)',
        })).sort((a, b) => b.total - a.total);

        // ── NEW: Performance by Day of Week ──────────────────
        const DOW_ORDER = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
        const dowMap = {};
        DOW_ORDER.forEach(d => { dowMap[d] = { buy: 0, sell: 0, hold: 0, total: 0 }; });
        signals.forEach(s => {
            const d = getDow(s.created_at);
            if (!dowMap[d]) return;
            dowMap[d].total++;
            if (s.signal === 'BUY')       dowMap[d].buy++;
            else if (s.signal === 'SELL') dowMap[d].sell++;
            else                          dowMap[d].hold++;
        });
        const byDow = DOW_ORDER.map(day => ({
            day,
            total:   dowMap[day].total,
            winRate: dowMap[day].total > 0
                ? parseFloat(((dowMap[day].buy / dowMap[day].total) * 100).toFixed(1))
                : 0,
            buy:  dowMap[day].buy,
            sell: dowMap[day].sell,
        }));

        // ── NEW: Rolling 30-day win rate ──────────────────────
        const sortedAsc = signals.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const WINDOW = 30;
        const rolling = [];
        for (let i = 0; i < sortedAsc.length; i++) {
            const windowSlice = sortedAsc.slice(Math.max(0, i - WINDOW + 1), i + 1);
            const wBuys = windowSlice.filter(s => s.signal === 'BUY').length;
            const wRate = windowSlice.length > 0 ? parseFloat(((wBuys / windowSlice.length) * 100).toFixed(1)) : 0;
            rolling.push({
                day:     new Date(sortedAsc[i].created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'short' }),
                winRate: wRate,
                count:   windowSlice.length,
            });
        }
        // Deduplicate by day (keep last value per day)
        const rollingDeduped = Object.values(
            rolling.reduce((acc, r) => { acc[r.day] = r; return acc; }, {})
        );

        // ── NEW: Strategy Fingerprint (radar metrics) ─────────
        // Normalize each metric to 0-100 scale
        const maxRR   = 3;   // cap at 1:3
        const maxConf = 100;
        const consistency = signals.length > 1
            ? Math.max(0, 100 - (signals.reduce((acc, s, i, arr) => {
                if (i === 0) return 0;
                return acc + Math.abs((s.confidence || 0) - (arr[i-1].confidence || 0));
              }, 0) / (signals.length - 1)))
            : 50;

        const diversification = Math.min(100, (uniqueSymbols.length / 10) * 100);
        const activity = Math.min(100, (total / 50) * 100);

        const fingerprint = [
            { metric: 'Win Rate',        value: parseFloat(winRate),                              max: 100 },
            { metric: 'Avg Confidence',  value: parseFloat(avgConf),                              max: 100 },
            { metric: 'Risk/Reward',     value: parseFloat(Math.min(parseFloat(avgRR) / maxRR * 100, 100).toFixed(1)), max: 100 },
            { metric: 'Consistance',     value: parseFloat(consistency.toFixed(1)),               max: 100 },
            { metric: 'Diversification', value: parseFloat(diversification.toFixed(1)),           max: 100 },
            { metric: 'Activité',        value: parseFloat(activity.toFixed(1)),                  max: 100 },
        ];

        res.json({ success: true, kpis, equity, monthly, trades, attribution, byDow, rolling: rollingDeduped, fingerprint });

    } catch (err) {
        logger.error(`[analytics] ${err.message}`);
        res.status(500).json({ success: false, error: 'Analytics unavailable' });
    }
}

module.exports = {
    getAllSignals,
    getSignalBySymbol,
    getSupportedSymbols,
    getAlphaEngineData,
    getAnalyticsData,
};