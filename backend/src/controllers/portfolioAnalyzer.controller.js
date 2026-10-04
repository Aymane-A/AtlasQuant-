/**
 * portfolioAnalyzer.controller.js — AtlasQuant AI
 * Analyzes the user's portfolio via Groq and returns structured recommendations.
 *
 * Uses the SAME data pipeline as the Portfolio page (DB + exchange balances +
 * live prices, shorts as negative exposure, same % base) so the AI quotes the
 * exact numbers the user sees on screen.
 */
const axios  = require('axios');
const db     = require('../config/db');
const logger = require('../utils/logger');
const { fetchLivePrices, fetchExchangeBalances, mergePositions } = require('./portfolioController');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Model selection (env first, then fallbacks) ──────────────────────────────
function getModelCandidates() {
  const list = [
    process.env.GROQ_MODEL,
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
  ].filter(Boolean);
  return [...new Set(list)];
}

function isModelError(err) {
  const status = err.response?.status;
  const code   = err.response?.data?.error?.code;
  const msg    = String(err.response?.data?.error?.message || '');
  return status === 404 || code === 'model_not_found' || code === 'model_decommissioned' ||
         /decommission|does not exist|not found/i.test(msg);
}
function isJsonError(err) {
  return err.response?.data?.error?.code === 'json_validate_failed';
}

async function callGroq(messages) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is missing in .env');

  let lastErr;
  for (const model of getModelCandidates()) {
    const isReasoning = model.startsWith('openai/gpt-oss');
    const body = {
      model,
      messages,
      temperature: 0.3,
      max_completion_tokens: isReasoning ? 6000 : 2000,
      response_format: { type: 'json_object' },
    };
    if (isReasoning) body.reasoning_effort = 'low';

    try {
      const r = await axios.post(GROQ_URL, body, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 45000,
      });
      logger.info(`[portfolioAnalyzer] Groq OK with model=${model}`);
      return r.data.choices[0].message.content;
    } catch (err) {
      lastErr = err;
      logger.error(`[portfolioAnalyzer] Groq failed model=${model} status=${err.response?.status} body=${JSON.stringify(err.response?.data || err.message)}`);
      if (!isModelError(err) && !isJsonError(err)) throw err;
    }
  }
  throw lastErr;
}

function parseJsonLoose(raw) {
  const clean = String(raw).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { /* try to extract the object */ }
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(clean.slice(s, e + 1));
  throw new Error('AI returned invalid JSON');
}

// Simple per-user cooldown → no accidental spam / quota burn
const LAST_CALL   = new Map();
const COOLDOWN_MS = 8000;

// ── POST /api/portfolio/analyze ──────────────────────────────────────────────
async function analyzePortfolio(req, res) {
  try {
    const userId = req.user.id;

    const last = LAST_CALL.get(userId) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
      return res.status(429).json({ success: false, error: 'Please wait a few seconds before re-analyzing.' });
    }
    LAST_CALL.set(userId, Date.now());

    // 1. Same sources as the Portfolio page
    const [posRes, exchangeBalances, accRes] = await Promise.all([
      db.query(
        `SELECT symbol, side, amount, average_entry, current_price, sector
         FROM portfolio WHERE user_id = $1`,
        [userId]
      ),
      fetchExchangeBalances(userId),
      db.query(`SELECT cash_balance FROM accounts WHERE user_id=$1 LIMIT 1`, [userId]),
    ]);

    const { positions, stableCash } = mergePositions(posRes.rows, exchangeBalances);
    if (positions.length === 0) {
      return res.status(400).json({ success: false, error: 'No positions to analyze' });
    }

    const dbCash = accRes.rows.length ? parseFloat(accRes.rows[0].cash_balance) : 0;
    const cash   = dbCash + stableCash;

    // 2. Live prices
    const symbols = [...new Set(positions.map(p => p.symbol))];
    const hints   = {};
    positions.forEach(p => { if (p.sector) hints[p.symbol] = p.sector; });
    const live = await fetchLivePrices(symbols, hints);

    // 3. Metrics (identical maths to getPortfolioData)
    let grossValue = 0, signedValue = 0, totalCost = 0, unrealised = 0;
    const processed = positions.map(p => {
      const sgn   = p.side === 'short' ? -1 : 1;
      const avg   = parseFloat(p.average_entry) || 0;
      const amt   = parseFloat(p.amount) || 0;
      const price = live[p.symbol]?.price > 0 ? live[p.symbol].price : (parseFloat(p.current_price) || avg);
      const val   = price * amt;
      const cost  = avg * amt;
      const pnl   = avg > 0 ? sgn * (price - avg) * amt : null;
      const pnlPct = avg > 0 && cost > 0 ? (pnl / cost) * 100 : null;

      grossValue  += val;
      signedValue += sgn * val;
      if (avg > 0) { totalCost += cost; unrealised += pnl; }

      return { symbol: p.symbol, side: p.side || 'long', sector: p.sector || 'Unknown', val, pnl, pnlPct };
    });

    const equity    = cash + signedValue;
    const allocBase = grossValue + Math.max(cash, 0);
    const pctOf     = (v) => (allocBase > 0 ? (v / allocBase) * 100 : 0);

    processed.forEach(p => { p.weight = pctOf(p.val); });
    processed.sort((a, b) => b.val - a.val);

    const maxWeight   = processed.length ? processed[0].weight : 0;
    const cashRatio   = pctOf(Math.max(cash, 0));
    const totalPnLPct = totalCost > 0 ? (unrealised / totalCost) * 100 : 0;

    const sectorMap = {};
    processed.forEach(p => { sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.val; });
    const sectors = {};
    Object.entries(sectorMap).forEach(([k, v]) => { sectors[k] = (grossValue > 0 ? (v / grossValue) * 100 : 0).toFixed(1) + '%'; });

    const withPnl = processed.filter(p => p.pnl != null);
    const winners = withPnl.filter(p => p.pnl > 0).sort((a, b) => b.pnlPct - a.pnlPct);
    const losers  = withPnl.filter(p => p.pnl < 0).sort((a, b) => a.pnlPct - b.pnlPct);

    const portfolioSummary = {
      totalValue:    equity.toFixed(2),
      grossExposure: grossValue.toFixed(2),
      cash:          cash.toFixed(2),
      cashRatio:     cashRatio.toFixed(1) + '%',
      unrealisedPnL: unrealised.toFixed(2),
      unrealisedPnLPct: totalPnLPct.toFixed(2) + '%',
      largestPosition: maxWeight.toFixed(1) + '%',
      positions:     processed.length,
      sectorExposure: sectors,
      connectedExchanges: [...new Set(exchangeBalances.map(b => b.exchange))],
      positions_detail: processed.map(p => ({
        symbol:   p.symbol,
        side:     p.side,
        sector:   p.sector,
        weight:   p.weight.toFixed(1) + '%',
        value:    p.val.toFixed(2),
        pnl:      p.pnl != null ? p.pnl.toFixed(2) : 'unknown (no cost basis)',
        pnlPct:   p.pnlPct != null ? p.pnlPct.toFixed(2) + '%' : 'unknown',
      })),
      top_winners: winners.slice(0, 3).map(p => `${p.symbol} +${p.pnlPct.toFixed(1)}%`),
      top_losers:  losers.slice(0, 3).map(p => `${p.symbol} ${p.pnlPct.toFixed(1)}%`),
    };

    // 4. Prompt
    const systemPrompt = `You are AtlasQuant AI — an expert quantitative portfolio analyst and trading advisor.
You analyze investment portfolios and provide sharp, actionable recommendations.
You always respond in valid JSON only. No markdown, no explanation outside JSON.

Rules:
- Percentages ("weight", "largestPosition", "cashRatio") are % of total portfolio (gross exposure + cash), exactly as shown in the user's app. Quote them as given; never recompute or invent numbers.
- sectorExposure is the share of invested (gross) exposure per sector.
- side "short" means the position was sold short: it profits when price falls and its value is a liability, not an asset.
- A HEDGE must be an offsetting trade (e.g. a long to offset a losing short, a short to offset a large long). Never recommend adding to an already losing short as a hedge.
- Only mention symbols from the data, or well-known liquid tickers for BUY ideas. Use "PORTFOLIO" for portfolio-wide advice.
- Be honest, specific and data-driven. Keep each reason under 25 words.`;

    const userPrompt = `Analyze this investment portfolio and return a JSON object with this exact structure:

{
  "score": <number 0-100, overall portfolio health>,
  "verdict": <"Strong" | "Good" | "Needs Attention" | "Urgent Action">,
  "verdict_reason": <one sharp sentence explaining the verdict>,
  "strengths": [<2-3 specific strengths with data>],
  "risks": [<2-4 specific risks with data>],
  "recommendations": [
    {
      "priority": <"high" | "medium" | "low">,
      "action": <"BUY" | "SELL" | "TRIM" | "HOLD" | "REBALANCE" | "HEDGE">,
      "symbol": <ticker or "PORTFOLIO">,
      "reason": <specific reason with numbers>,
      "impact": <expected impact on portfolio>
    }
  ],
  "diversification": {
    "score": <0-100>,
    "note": <brief assessment>
  },
  "risk_level": <"Low" | "Moderate" | "High" | "Very High">,
  "summary": <2-3 sentence overall summary for the investor>
}

Portfolio data:
${JSON.stringify(portfolioSummary, null, 2)}`;

    // 5. Call Groq
    const raw      = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ]);
    const analysis = parseJsonLoose(raw);

    analysis.score           = Math.max(0, Math.min(100, Number(analysis.score) || 0));
    analysis.strengths       = Array.isArray(analysis.strengths) ? analysis.strengths : [];
    analysis.risks           = Array.isArray(analysis.risks) ? analysis.risks : [];
    analysis.recommendations = Array.isArray(analysis.recommendations) ? analysis.recommendations : [];

    analysis._meta = {
      analyzedAt:  new Date().toISOString(),
      positions:   processed.length,
      totalValue:  equity,
      totalPnLPct: totalPnLPct.toFixed(2),
    };

    res.json({ success: true, analysis });

  } catch (err) {
    logger.error(`[portfolioAnalyzer] ${err.message} | status=${err.response?.status} | body=${JSON.stringify(err.response?.data || null)}`);
    const status = err.response?.status;
    const msg =
      err.message?.includes('GROQ_API_KEY') ? 'AI service not configured.' :
      status === 401 ? 'AI key invalid.' :
      status === 429 ? 'AI rate limit reached. Try again in a minute.' :
      'Analysis failed. Try again.';
    res.status(500).json({ success: false, error: msg });
  }
}

module.exports = { analyzePortfolio };