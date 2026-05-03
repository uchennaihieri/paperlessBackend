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
import mobileSendOtpRouter from "./routes/mobile_sendOtp";
import mobileVerifyOtpRouter from "./routes/mobile_verifyOtp";
import mobileDashboardRouter from "./routes/mobile_dashboard";
import mobileDepositRouter from "./routes/mobile_deposit";
import mobilePartialRouter from "./routes/mobile_partial";
import reportsRouter from "./routes/reports";
import branchesRouter from "./routes/branches";
import templatesRouter from "./routes/templates";
import documentsRouter from "./routes/documents";
import historyRouter from "./routes/history";
import auditRouter from "./routes/audit";
import identityRouter from "./routes/identity";
import mobileSubmitRouter from "./routes/mobile_submit";
import prerequisitesRouter from "./routes/prerequisites";
import formAccessRouter from "./routes/formAccess";
import journalRouter from "./routes/journal";
import lookupRouter from "./routes/lookup";

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
v1.use("/mobile_send-otp", mobileSendOtpRouter);
v1.use("/mobile_verify-otp", mobileVerifyOtpRouter);
v1.use("/mobile_dashboard", mobileDashboardRouter);
v1.use("/mobile_deposit", mobileDepositRouter);
v1.use("/mobile_partial", mobilePartialRouter);
v1.use("/reports", reportsRouter);
v1.use("/branches", branchesRouter);
v1.use("/templates", templatesRouter);
v1.use("/documents", documentsRouter);
v1.use("/history", historyRouter);
v1.use("/audit", auditRouter);
v1.use("/identity", identityRouter);
v1.use("/mobile_submit", mobileSubmitRouter);
v1.use("/prerequisites", prerequisitesRouter);
v1.use("/forms-access", formAccessRouter);
v1.use("/journal", journalRouter);
v1.use("/lookup", lookupRouter);


app.use("/api/v1", v1);

// ── 404 & error handlers
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`🚀  Paperless API listening on http://localhost:${PORT}`);
});

export default app;
