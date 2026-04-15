import "express-async-errors";
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";

import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { notFound } from "./middleware/notFound";

// ── Routers
import authRouter from "./routes/auth";
import formsRouter from "./routes/forms";
import submissionsRouter from "./routes/submissions";
import workflowRouter from "./routes/workflow";
import securityRouter from "./routes/security";
import teamsRouter from "./routes/teams";
import uploadRouter from "./routes/upload";
import filesRouter from "./routes/files";
import pdfRouter from "./routes/pdf";
import mobileRouter from "./routes/mobile";

const app = express();
const PORT = process.env.PORT ?? 4000;

// ── Security & compression
app.use(helmet());
app.use(compression() as express.RequestHandler);

// ── CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ── Body parsing
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ── HTTP request logging
app.use(morgan("dev", { stream: { write: (msg) => logger.http(msg.trim()) } }));

// ── Health-check
app.get("/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() })
);

// ── API routes (v1)
const v1 = express.Router();
v1.use("/auth", authRouter);
v1.use("/forms", formsRouter);
v1.use("/submissions", submissionsRouter);
v1.use("/workflow", workflowRouter);
v1.use("/security", securityRouter);
v1.use("/teams", teamsRouter);
v1.use("/upload", uploadRouter);
v1.use("/file", filesRouter);
v1.use("/pdf", pdfRouter);
v1.use("/mobile", mobileRouter);

app.use("/api/v1", v1);

// ── 404 & error handlers
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`🚀  Paperless API listening on http://localhost:${PORT}`);
});

export default app;
