/**
 * SharePoint / Microsoft Graph API helper
 *
 * Uses the OAuth2 client-credentials flow to obtain a token, then
 * uploads and downloads files from a configured SharePoint site via
 * the Graph API drive endpoint.
 *
 * Token is cached in-memory and refreshed automatically before expiry.
 */

const TENANT_ID     = process.env.SHAREPOINT_TENANT_ID     ?? "";
const CLIENT_ID     = process.env.SHAREPOINT_CLIENT_ID     ?? "";
const CLIENT_SECRET = process.env.SHAREPOINT_CLIENT_SECRET ?? "";
const SITE_URL      = process.env.SHAREPOINT_SITE_URL      ?? "";

/** Returns true when all required env vars are set. */
export function isSharePointEnabled(): boolean {
  return !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET && SITE_URL);
}

// ── Token cache ───────────────────────────────────────────────────────────────

interface TokenCache { token: string; expiresAt: number }
let tokenCache: TokenCache | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope:         "https://graph.microsoft.com/.default",
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }
  );

  const data = await res.json() as any;
  if (!data.access_token) {
    throw new Error(`SharePoint auth failed: ${JSON.stringify(data)}`);
  }

  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

// ── Site ID cache ─────────────────────────────────────────────────────────────

let cachedSiteId: string | null = null;

async function getSiteId(): Promise<string> {
  if (cachedSiteId) return cachedSiteId;

  const url      = new URL(SITE_URL);
  const hostname = url.hostname;          // fincaint.sharepoint.com
  const sitePath = url.pathname;          // /sites/NGWorkFlowAutomateLive

  const token = await getAccessToken();
  const res   = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const data = await res.json() as any;
  if (!data.id) throw new Error(`Could not resolve SharePoint site ID: ${JSON.stringify(data)}`);

  cachedSiteId = data.id as string;
  return cachedSiteId;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload a file buffer to SharePoint.
 *
 * @param buffer   - Raw file content
 * @param fileName - Unique file name (as stored in UploadedFile.fileName)
 * @param mimeType - MIME type of the file
 * @param folder   - Target folder inside the drive root (default: env SHAREPOINT_UPLOAD_FOLDER or "uploads")
 * @returns The relative drive path stored in UploadedFile.filePath, e.g. "uploads/1234-file.pdf"
 */
export async function uploadToSharePoint(
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  folder: string = process.env.SHAREPOINT_UPLOAD_FOLDER ?? "uploads"
): Promise<string> {
  const token  = await getAccessToken();
  const siteId = await getSiteId();

  // Relative path within the document library root
  const drivePath = `${folder}/${fileName}`;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${drivePath}:/content`,
    {
      method: "PUT",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": mimeType,
      },
      body: buffer,
    }
  );

  const data = await res.json() as any;
  if (!data.id) {
    throw new Error(`SharePoint upload failed for "${fileName}": ${JSON.stringify(data)}`);
  }

  // Return relative path used to reconstruct the download URL later
  return drivePath;
}

/**
 * Download a file from SharePoint by its stored drive path.
 *
 * @param drivePath - The relative path returned by uploadToSharePoint, e.g. "uploads/1234-file.pdf"
 * @returns Buffer of the file content and its MIME type
 */
export async function downloadFromSharePoint(
  drivePath: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const token  = await getAccessToken();
  const siteId = await getSiteId();

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${drivePath}:/content`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    throw new Error(`SharePoint download failed for "${drivePath}": ${res.status} ${res.statusText}`);
  }

  const buffer   = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  return { buffer, mimeType };
}
