import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";

const router = Router();

/**
 * GET /api/v1/status
 * Returns the operational status of the API server and its database connection.
 */
router.get("/", async (_req: Request, res: Response) => {
  const startTime = process.hrtime.bigint();

  // ── Database connectivity check
  let dbStatus: "ok" | "error" = "error";
  let dbLatencyMs: number | null = null;
  let dbError: string | null = null;

  try {
    const dbStart = process.hrtime.bigint();
    await prisma.$queryRaw`SELECT 1`;
    const dbEnd = process.hrtime.bigint();
    dbLatencyMs = Number(dbEnd - dbStart) / 1_000_000;
    dbStatus = "ok";
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const endTime = process.hrtime.bigint();
  const totalLatencyMs = Number(endTime - startTime) / 1_000_000;

  const isHealthy = dbStatus === "ok";

  return res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV ?? "development",
    version: process.env.npm_package_version ?? "unknown",
    latencyMs: parseFloat(totalLatencyMs.toFixed(2)),
    services: {
      api: {
        status: "ok",
      },
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs !== null ? parseFloat(dbLatencyMs.toFixed(2)) : null,
        ...(dbError ? { error: dbError } : {}),
      },
    },
  });
});

export default router;
