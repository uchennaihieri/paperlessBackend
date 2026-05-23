/**
 * GET /app/download
 *
 * Public (no authentication required) endpoint that streams the latest
 * mobile APK file directly from SharePoint to the client.
 *
 * The APK must be stored in the SharePoint drive at:
 *   mobileapp/app-release.apk
 * (configurable via MOBILE_APP_PATH env var)
 *
 * This endpoint:
 *   - Fetches an access token using service-principal credentials
 *   - Streams the file content (does NOT buffer the whole file in memory)
 *   - Sets Content-Type and Content-Disposition so Android recognises the download
 *   - Requires NO user login — safe to use in QR codes
 */

import { Router, Request, Response } from "express";

const TENANT_ID = process.env.SHAREPOINT_TENANT_ID ?? "";
const CLIENT_ID = process.env.SHAREPOINT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET ?? "";
const SITE_URL = process.env.SHAREPOINT_SITE_URL ?? "";

// Path inside the SharePoint drive where the APK lives.
// Override with MOBILE_APP_PATH env var if needed.
const MOBILE_APP_PATH = process.env.MOBILE_APP_PATH ?? "mobileapp/app-release.apk";
const APK_FILENAME = process.env.MOBILE_APK_FILENAME ?? "FINCALite.apk";

const router = Router();

// ── Internal helpers (no auth caching shared with sharepoint.ts to keep
//    this route self-contained and independently deployable) ───────────────────

interface TokenCache { token: string; expiresAt: number }
let tokenCache: TokenCache | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }
  );
  const data = await res.json() as any;
  if (!data.access_token) throw new Error(`SharePoint auth failed: ${JSON.stringify(data)}`);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function getSiteId(token: string): Promise<string> {
  const url = new URL(SITE_URL);
  const hostname = url.hostname;
  const sitePath = url.pathname;
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as any;
  if (!data.id) throw new Error(`Could not resolve SharePoint site ID: ${JSON.stringify(data)}`);
  return data.id as string;
}

// ── GET /app/download ─────────────────────────────────────────────────────────

router.get("/", async (_req: Request, res: Response) => {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET || !SITE_URL) {
    res.status(503).json({ error: "Mobile app download is not configured on this server." });
    return;
  }

  let token: string;
  let siteId: string;

  try {
    token = await getToken();
    siteId = await getSiteId(token);
  } catch (err: any) {
    console.error("[app-download] Auth error:", err.message);
    res.status(502).json({ error: "Could not authenticate with file storage." });
    return;
  }

  // Build the Graph API URL for the APK file — we request the download redirect
  // rather than the metadata endpoint so we get a streaming-friendly response.
  const graphUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${MOBILE_APP_PATH}:/content`;

  let spRes: globalThis.Response;
  try {
    spRes = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow", // follow the Graph API redirect to the actual CDN URL
    });
  } catch (err: any) {
    console.error("[app-download] Fetch error:", err.message);
    res.status(502).json({ error: "Could not reach file storage." });
    return;
  }

  if (!spRes.ok) {
    console.error(`[app-download] SharePoint returned ${spRes.status} for path "${MOBILE_APP_PATH}"`);
    res.status(spRes.status === 404 ? 404 : 502).json({
      error: spRes.status === 404
        ? "APK file not found. Please contact your administrator."
        : "Failed to retrieve the APK file from storage.",
    });
    return;
  }

  // ── Set headers BEFORE streaming ─────────────────────────────────────────────
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${APK_FILENAME}"`);
  res.setHeader("Cache-Control", "no-store");

  // Forward Content-Length if SharePoint provides it (enables progress bar on device)
  const contentLength = spRes.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  // ── Stream the response body directly to the client ──────────────────────────
  // We use Node's Readable.fromWeb to pipe the WHATWG ReadableStream from fetch()
  // into the Express response stream — no full-file buffering.
  if (!spRes.body) {
    res.status(502).json({ error: "Empty response from file storage." });
    return;
  }

  const { Readable } = await import("stream");
  const nodeStream = Readable.fromWeb(spRes.body as any);

  nodeStream.on("error", (err) => {
    console.error("[app-download] Stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Stream interrupted." });
    } else {
      res.destroy();
    }
  });

  nodeStream.pipe(res);
});

export default router;
