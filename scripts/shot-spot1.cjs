const { chromium } = require("playwright-core");
const path = require("path");
const dir = path.resolve(__dirname, "..", "tmp-shots");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1360, height: 920 } });
  await p.goto("http://127.0.0.1:5174/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1800);
  await p.evaluate(() => {
    const h = [...document.querySelectorAll("h3")].find((e) => /забрал этикетку/i.test(e.textContent || ""));
    if (h) h.scrollIntoView({ block: "center" });
  });
  await p.waitForTimeout(700);
  await p.screenshot({ path: path.join(dir, "spot1-ru.png") });
  console.log("done");
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
