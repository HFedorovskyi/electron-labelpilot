const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const dir = path.resolve(__dirname, "..", "tmp-shots");
fs.mkdirSync(dir, { recursive: true });

const clickText = (page, txt) => page.evaluate((t) => {
  const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
  if (el) el.click(); return !!el;
}, txt);

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
  await page.goto("http://127.0.0.1:5174/__preview", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(dir, "panel-admin.png") });
  console.log("admin shot");

  await clickText(page, "Личный кабинет клиента");
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(dir, "panel-cabinet.png") });
  console.log("cabinet shot");

  // back to admin, open the issue modal
  await clickText(page, "Администратор");
  await page.waitForTimeout(500);
  await clickText(page, "Выдать лицензию");
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(dir, "panel-modal.png") });
  console.log("modal shot");

  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
