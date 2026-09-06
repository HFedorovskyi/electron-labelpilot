const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const dir = path.resolve(__dirname, "..", "tmp-shots");
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 940 } });
  await page.goto("http://127.0.0.1:5174/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const el = await page.$("#equipment");
  if (el) { await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(500); await el.screenshot({ path: path.join(dir, "equip-ru.png") }); console.log("equip shot"); }
  else console.log("no #equipment");
  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
