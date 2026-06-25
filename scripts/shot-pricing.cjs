const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const dir = path.resolve(__dirname, "..", "tmp-shots");
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 940 } });
  await page.goto("http://127.0.0.1:5174/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // Scroll the price card (the €/price block) into view.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) => /Stripe/i.test(b.textContent || ""));
    if (el) el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(dir, "web-pricing-close.png") });
  console.log("shot:", path.join(dir, "web-pricing-close.png"));
  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
