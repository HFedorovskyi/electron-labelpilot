const { chromium } = require("playwright-core");
const path = require("path"); const dir = path.resolve(__dirname,"..","tmp-shots");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1320, height: 900 } });
  await p.goto("http://127.0.0.1:5174/contacts", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(()=>{});
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(dir,"contacts2.png") });
  console.log("done"); await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
