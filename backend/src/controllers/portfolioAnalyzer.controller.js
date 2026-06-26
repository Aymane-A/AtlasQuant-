/**
 * portfolioAnalyzer.controller.js — AtlasQuant AI
 * Analyzes user portfolio via Groq AI and returns structured recommendations
 */
const axios  = require('axios');
const db     = require('../config/db');
const logger = require('../utils/logger');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';

// ── POST /api/portfolio/analyze ───────────────────────────────────────────────
async function analyzePortfolio(req, res) {
  try {
    const userId = req.user.id;

    // 1. Fetch portfolio data from DB
    const { rows: positions } = await db.query(
      `SELECT symbol, side, amount, average_entry, current_price, sector
       FROM portfolio WHERE user_id = $1`,
      [userId]
    );

    const { rows: accountRows } = await db.query(
      `SELECT cash_balance FROM accounts WHERE user_id=$1 LIMIT 1`,
      [userId]
    );
    const cash = accountRows.length ? parseFloat(accountRows[0].cash_balance) : 0;

    // 2. Fetch connected exchanges count
    const { rows: exchangeRows } = await db.query(
      `SELECT exchange_id, mode FROM user_exchange_connections WHERE user_id=$1`,
      [userId]
    );

    if (positions.length === 0) {
      return res.status(400).json({ success: false, error: 'No positions to analyze' });
    }

    // 3. Compute portfolio metrics
    let totalCost = 0, totalValue = cash;
    const processedPositions = positions.map(p => {
      const avg    = parseFloat(p.average_entry);
      const cur    = parseFloat(p.current_price) || avg;
      const amt    = parseFloat(p.amount);
      const val    = cur * amt;
      const cost   = avg * amt;
      const pnl    = p.side === 'short' ? (avg - cur) * amt : (cur - avg) * amt;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      totalCost  += cost;
      totalValue += val;
      return {
        symbol:  p.symbol,
        side:    p.side,
        sector:  p.sector || 'Unknown',
        amount:  amt,
        avgEntry: avg,
        curPrice: cur,
        value:   val,
        pnl:     pnl,
        pnlPct:  pnlPct,
        weight:  0, // filled below
      };
    });

    const investedValue = totalValue - cash;
    processedPositions.forEach(p => {
      p.weight = investedValue > 0 ? (p.value / investedValue) * 100 : 0;
    });

    const totalPnL    = totalValue - cash - totalCost;
    const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
    const cashRatio   = totalValue > 0 ? (cash / totalValue) * 100 : 0;
    const maxWeight   = Math.max(...processedPositions.map(p => p.weight));

    // Sector breakdown
    const sectorMap = {};
    processedPositions.forEach(p => {
      sectorMap[p.sector] = (sectorMap[p.sector] || 0) + p.weight;
    });

    // Winning vs losing
    const winners = processedPositions.filter(p => p.pnl > 0).sort((a,b) => b.pnlPct - a.pnlPct);
    const losers  = processedPositions.filter(p => p.pnl < 0).sort((a,b) => a.pnlPct - b.pnlPct);

    // 4. Build AI prompt
    const portfolioSummary = {
      totalValue:     totalValue.toFixed(2),
      investedValue:  investedValue.toFixed(2),
      cash:           cash.toFixed(2),
      cashRatio:      cashRatio.toFixed(1) + '%',
      totalPnL:       totalPnL.toFixed(2),
      totalPnLPct:    totalPnLPct.toFixed(2) + '%',
      concentration:  maxWeight.toFixed(1) + '%',
      positions:      processedPositions.length,
      sectors:        sectorMap,
      connectedExchanges: exchangeRows.map(e => e.exchange_id),
      positions_detail: processedPositions.map(p => ({
        symbol:  p.symbol,
        side:    p.side,
        sector:  p.sector,
        weight:  p.weight.toFixed(1) + '%',
        pnl:     p.pnl.toFixed(2),
        pnlPct:  p.pnlPct.toFixed(2) + '%',
        value:   p.value.toFixed(2),
      })),
      top_winners: winners.slice(0,3).map(p => `${p.symbol} +${p.pnlPct.toFixed(1)}%`),
      top_losers:  losers.slice(0,3).map(p => `${p.symbol} ${p.pnlPct.toFixed(1)}%`),
    };

    const systemPrompt = `You are AtlasQuant AI — an expert quantitative portfolio analyst and trading advisor. 
You analyze investment portfolios and provide sharp, actionable recommendations.
You always respond in valid JSON only. No markdown, no explanation outside JSON.

Your analysis must be honest, specific, and data-driven. Never be vague.
Flag real risks. Praise real strengths. Give concrete actions with specific symbols and percentages.`;

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
${JSON.stringify(portfolioSummary, null, 2)}

Be specific about symbols, percentages, and dollar amounts. Reference actual positions in your analysis.`;

    // 5. Call Groq
    const groqRes = await axios.post(
      GROQ_URL,
      {
        model:       GROQ_MODEL,
        messages:    [{ role:'system', content:systemPrompt }, { role:'user', content:userPrompt }],
        max_tokens:  1200,
        temperature: 0.3,
      },
      {
        headers: { Authorization:`Bearer ${GROQ_API_KEY}`, 'Content-Type':'application/json' },
        timeout: 30000,
      }
    );

    const raw  = groqRes.data.choices[0].message.content.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);

    // 6. Attach portfolio metrics
    analysis._meta = {
      analyzedAt:   new Date().toISOString(),
      positions:    positions.length,
      totalValue,
      totalPnLPct:  totalPnLPct.toFixed(2),
    };

    res.json({ success: true, analysis });

  } catch (err) {
    logger.error(`[portfolioAnalyzer] ${err.message}`);
    if (err.response?.data) logger.error(`[portfolioAnalyzer] Groq error:`, JSON.stringify(err.response.data));
    res.status(500).json({ success: false, error: 'Analysis failed. Try again.' });
  }
}

module.exports = { analyzePortfolio };