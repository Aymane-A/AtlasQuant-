require("dotenv").config();

function optional(key, defaultValue = "") {
  return process.env[key] || defaultValue;
}

const NODE_ENV      = optional("NODE_ENV", "development");
const IS_PRODUCTION = NODE_ENV === "production";

// JWT_SECRET: no silent fallback in production. A missing/weak secret means
// anyone can forge valid tokens, so we refuse to start instead.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PRODUCTION) {
    throw new Error("[env] JWT_SECRET is required in production (use 32+ random chars).");
  }
  JWT_SECRET = "dev-secret-change-in-production";
  console.warn("[env] JWT_SECRET not set — using an insecure dev secret (development only).");
} else if (IS_PRODUCTION && JWT_SECRET.length < 32) {
  throw new Error("[env] JWT_SECRET is too short for production (min 32 chars).");
}

module.exports = {
  PORT:      optional("PORT", "5000"),
  NODE_ENV,
  IS_DEV:        NODE_ENV === "development",
  IS_PRODUCTION,

  // Public URL of the frontend. Used for links in emails/Telegram, CORS, CSP.
  FRONTEND_URL: optional("FRONTEND_URL", "http://localhost:3000").replace(/\/+$/, ""),
  // Extra allowed CORS origins (comma-separated).
  ALLOWED_ORIGINS: optional("ALLOWED_ORIGINS").split(",").map(s => s.trim()).filter(Boolean),
  // Set to a number of proxy hops (e.g. 1 behind nginx/Render) or "true".
  TRUST_PROXY: optional("TRUST_PROXY", ""),

  JWT_SECRET,
  JWT_EXPIRES_IN: optional("JWT_EXPIRES_IN", "7d"),
  // How long after expiry a token may still be exchanged at /auth/refresh.
  REFRESH_GRACE_SECONDS: parseInt(optional("REFRESH_GRACE_SECONDS", "86400"), 10),

  API_RATE_LIMIT_MAX:      parseInt(optional("API_RATE_LIMIT_MAX", "500"), 10),
  BACKTEST_RATE_LIMIT_MAX: parseInt(optional("BACKTEST_RATE_LIMIT_MAX", "20"), 10),

  BINANCE_API_KEY:    optional("BINANCE_API_KEY"),
  BINANCE_API_SECRET: optional("BINANCE_API_SECRET"),
  COINGECKO_API_KEY:  optional("COINGECKO_API_KEY"),
  CMC_API_KEY:        optional("CMC_API_KEY"),
  GROQ_API_KEY:       optional("GROQ_API_KEY"),

  PAPER_TRADING:      optional("PAPER_TRADING", "true") === "true",
  // Live trading safety switches (both default to the SAFE value).
  // Block live orders when the risk limits cannot be verified (e.g. equity unknown).
  RISK_STRICT_LIVE: optional("RISK_STRICT_LIVE", "true") !== "false",
  // Require a verified email before connecting/switching an exchange to LIVE or placing live orders.
  REQUIRE_VERIFIED_EMAIL_FOR_LIVE: optional("REQUIRE_VERIFIED_EMAIL_FOR_LIVE", "true") !== "false",
  MAX_RISK_PER_TRADE: parseFloat(optional("MAX_RISK_PER_TRADE", "0.02")),
  MAX_DAILY_DRAWDOWN: parseFloat(optional("MAX_DAILY_DRAWDOWN", "0.10")),

  COINGECKO_URL:  "https://api.coingecko.com/api/v3",
  CMC_URL:        "https://pro-api.coinmarketcap.com/v1",
  BLOCKCHAIN_URL: "https://blockchain.info",
};
