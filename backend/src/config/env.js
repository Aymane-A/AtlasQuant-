require("dotenv").config();

function optional(key, defaultValue = "") {
  return process.env[key] || defaultValue;
}

module.exports = {
  PORT:      optional("PORT", "5000"),
  NODE_ENV:  optional("NODE_ENV", "development"),
  IS_DEV:    optional("NODE_ENV", "development") === "development",

  MONGODB_URI:        optional("MONGODB_URI", "mongodb://localhost:27017/atlasquant"),
  JWT_SECRET:         optional("JWT_SECRET", "dev-secret-change-in-production"),
  JWT_EXPIRES_IN:     optional("JWT_EXPIRES_IN", "7d"),

  BINANCE_API_KEY:    optional("BINANCE_API_KEY"),
  BINANCE_API_SECRET: optional("BINANCE_API_SECRET"),
  COINGECKO_API_KEY:  optional("COINGECKO_API_KEY"),
  CMC_API_KEY:        optional("CMC_API_KEY"),
  GROQ_API_KEY:       optional("GROQ_API_KEY"),

  PAPER_TRADING:      optional("PAPER_TRADING", "true") === "true",
  MAX_RISK_PER_TRADE: parseFloat(optional("MAX_RISK_PER_TRADE", "0.02")),
  MAX_DAILY_DRAWDOWN: parseFloat(optional("MAX_DAILY_DRAWDOWN", "0.10")),

  COINGECKO_URL:  "https://api.coingecko.com/api/v3",
  CMC_URL:        "https://pro-api.coinmarketcap.com/v1",
  BLOCKCHAIN_URL: "https://blockchain.info",
};