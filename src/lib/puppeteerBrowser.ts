import puppeteer, { Browser } from "puppeteer";

/**
 * Launch a Puppeteer browser instance that works in all environments:
 *   - Production (Docker/Railway): uses system Chromium installed in the image,
 *     pointed to by PUPPETEER_EXECUTABLE_PATH env var.
 *   - Local Windows dev: falls back to the locally installed Chrome/Edge.
 */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  // Production path — use system Chromium
  if (executablePath) {
    return puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }

  // Local dev fallback — try Chrome, then Edge
  try {
    return await puppeteer.launch({ headless: true, channel: "chrome" });
  } catch {
    return puppeteer.launch({ headless: true, channel: "msedge" as any });
  }
}
