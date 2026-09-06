// Capture marketing screenshots of the main LabelPilot screens.
// Requires the renderer dev server on 127.0.0.1:5173 (electron loads it when not packaged).
const { _electron } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const APP_DIR = path.resolve(__dirname, "..");
const SHOT_DIR = path.join(APP_DIR, "tmp-shots", "app");
fs.mkdirSync(SHOT_DIR, { recursive: true });
const electronBin = path.join(APP_DIR, "node_modules", "electron", "dist", "electron.exe");

async function pickPage(app) {
  for (let i = 0; i < 40; i++) {
    const w = app.windows().find((x) => x.url().startsWith("http"));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 500));
  }
  return app.firstWindow();
}

const hasSidebar = (page) => page.evaluate(() =>
  [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Весовой товар")));

const screens = [
  { file: "01-weighing", nav: ["Весовой товар"] },
  { file: "02-fixed-weight", nav: ["Фикс. вес"] },
  { file: "03-print-job", nav: ["По заданию"] },
  { file: "04-products", nav: ["Номенклатура"] },
];

(async () => {
  const app = await _electron.launch({ executablePath: electronBin, args: ["."], cwd: APP_DIR, timeout: 60000 });
  const page = await pickPage(app);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(7000);

  if (!(await hasSidebar(page))) {
    // Login gate. Try: continue-without (empty state) OR click an operator tile (one-tap if no PIN).
    const action = await page.evaluate(() => {
      const cont = [...document.querySelectorAll("button")].find((b) => /без оператора|without operator/i.test(b.textContent || ""));
      if (cont) { cont.click(); return "CONTINUE_WITHOUT"; }
      const grid = document.querySelector(".grid");
      const tile = grid && grid.querySelector("button");
      if (tile) { tile.click(); return "OPERATOR_TILE"; }
      return "NO_ACTION";
    });
    await page.waitForTimeout(3000);
    console.log("gate action:", action);
  }

  if (!(await hasSidebar(page))) {
    await page.screenshot({ path: path.join(SHOT_DIR, "00-blocked.png") });
    console.log("BLOCKED: could not reach main UI (likely PIN required). Saved 00-blocked.png");
    await app.close();
    process.exit(3);
  }

  for (const s of screens) {
    await page.evaluate((tt) => {
      const els = [...document.querySelectorAll("button, a")];
      const el = els.find((e) => tt.some((t) => (e.textContent || "").trim() === t))
        || els.find((e) => tt.some((t) => (e.textContent || "").includes(t)));
      if (el) el.click();
    }, s.nav);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(SHOT_DIR, s.file + ".png") });
    console.log("captured", s.file);
  }
  await app.close();
})().catch((e) => { console.error("ERR", (e && e.stack) || e); process.exit(1); });
