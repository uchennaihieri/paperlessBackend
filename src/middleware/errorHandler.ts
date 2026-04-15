import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  logger.error(err.message, { stack: err.stack });

  const status = (err as any).status ?? (err as any).statusCode ?? 500;
  res.status(status).json({
    success: false,
    error: err.message ?? "Internal Server Error",
  });
}
