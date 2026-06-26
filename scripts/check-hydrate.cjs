const { chromium } = require("playwright-core");
const path = require("path");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1320, height: 860 } });
  const errs = [];
  p.on("console", m => { if (m.type()==="error") errs.push(m.text()); });
  p.on("pageerror", e => errs.push("PAGEERROR: "+e.message));
  await p.goto("http://127.0.0.1:4180/", { waitUntil: "networkidle", timeout: 30000 }).catch(()=>{});
  await p.waitForTimeout(2500);
  // interactivity check: click a nav link works (hydrated)
  const navWorks = await p.evaluate(()=>!!document.querySelector('a[href="/demo"]'));
  await p.screenshot({ path: path.resolve(__dirname,"..","tmp-shots","ssg-preview.png") });
  console.log("nav link present:", navWorks);
  console.log("console errors:", errs.length ? JSON.stringify(errs.slice(0,8),null,1) : "none");
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
