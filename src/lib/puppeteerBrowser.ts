import puppeteer, { Browser } from "puppeteer";

/**
 * Launch a Puppeteer browser instance that works in all environments:
 *   - Production (Docker/Railway): uses system Chromium installed in the image,
 *     pointed to by PUPPETEER_EXECUTABLE_PATH env var.
 *   - Local Windows dev: falls back to the locally installed Chrome/Edge.
 */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  const defaultArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];

  // Add a unique userDataDir to prevent lockfile (EBUSY) conflicts during concurrent or crashed runs
  const os = require('os');
  const path = require('path');
  const crypto = require('crypto');
  const userDataDir = path.join(os.tmpdir(), `puppeteer_profile_${crypto.randomBytes(8).toString('hex')}`);

  // Production path — use system Chromium if explicitly set
  if (executablePath) {
    return puppeteer.launch({
      headless: true,
      executablePath,
      args: defaultArgs,
      userDataDir,
    });
  }

  // Fallback 1: Try default bundled puppeteer Chromium (needs sandbox disabled in Docker)
  try {
    return await puppeteer.launch({ 
      headless: true, 
      args: defaultArgs,
      userDataDir,
    });
  } catch (err1) {
    console.warn("Failed to launch bundled Chromium, trying system Chrome...", err1);
    
    // Fallback 2: Local dev Windows Chrome
    try {
      return await puppeteer.launch({ 
        headless: true, 
        channel: "chrome",
        args: defaultArgs,
        userDataDir,
      });
    } catch (err2) {
      console.warn("Failed to launch system Chrome, trying Edge...", err2);
      
      // Fallback 3: Local dev Windows Edge
      return puppeteer.launch({ 
        headless: true, 
        channel: "msedge" as any,
        args: defaultArgs,
        userDataDir,
      });
    }
  }
}
