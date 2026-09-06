// Screenshot the sales frontend (dev server on 127.0.0.1:5174) via headless Edge.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const dir = path.resolve(__dirname, "..", "tmp-shots");
fs.mkdirSync(dir, { recursive: true });

const pages = [
  ["web-landing", "http://127.0.0.1:5174/"],
  ["web-login", "http://127.0.0.1:5174/login"],
  ["web-pricing", "http://127.0.0.1:5174/pricing"],
];

(async () => {
  let browser;
  for (const channel of ["msedge", "chrome"]) {
    try { browser = await chromium.launch({ channel, headless: true }); console.log("launched via", channel); break; }
    catch (e) { console.log("channel", channel, "failed:", e.message); }
  }
  if (!browser) { console.error("no browser channel available"); process.exit(2); }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const [name, url] of pages) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const f = path.join(dir, name + ".png");
    await page.screenshot({ path: f, fullPage: true });
    console.log("shot:", f);
  }
  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
