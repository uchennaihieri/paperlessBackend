import winston from "winston";

const { combine, timestamp, printf, colorize, errors } = winston.format;

const fmt = printf(({ level, message, timestamp: ts, stack }) => {
  return stack
    ? `${ts} [${level}]: ${message}\n${stack}`
    : `${ts} [${level}]: ${message}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: combine(
    errors({ stack: true }),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    colorize({ all: true }),
    fmt
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});
