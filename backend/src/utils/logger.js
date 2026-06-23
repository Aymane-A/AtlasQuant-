const winston = require("winston");
const path    = require("path");
const fs      = require("fs");

const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

winston.addColors({ error: "red", warn: "yellow", info: "cyan", debug: "white" });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase().padEnd(5)} — ${message}`
  )
);

const logger = winston.createLogger({
  level: "debug",
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize({ all: true }), fmt),
      level: "info",
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "atlasquant.log"),
      format: fmt, level: "debug", maxsize: 5 * 1024 * 1024, maxFiles: 3,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "errors.log"),
      format: fmt, level: "error",
    }),
  ],
});

module.exports = logger;