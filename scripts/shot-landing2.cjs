const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const dir = path.resolve(__dirname, "..", "tmp-shots");
fs.mkdirSync(dir, { recursive: true });

const clickLang = (page, code) => page.evaluate((c) => {
  const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === c);
  if (el) el.click(); return !!el;
}, code);

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 940 } });
  await page.goto("http://127.0.0.1:5174/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(dir, "ln-hero-ru.png") });          // viewport (hero) RU
  await page.screenshot({ path: path.join(dir, "ln-full-ru.png"), fullPage: true });

  await clickLang(page, "UA");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(dir, "ln-hero-ua.png") });
  await page.screenshot({ path: path.join(dir, "ln-full-ua.png"), fullPage: true });

  // scroll to spotlights for a close-up (RU again)
  await clickLang(page, "RU");
  await page.waitForTimeout(800);
  await page.evaluate(() => { const el = document.getElementById("advantages"); if (el) window.scrollTo(0, el.offsetTop + 700); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(dir, "ln-spots-ru.png") });
  console.log("done");
  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
