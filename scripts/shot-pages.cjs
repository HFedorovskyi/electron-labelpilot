const { chromium } = require("playwright-core");
const path = require("path"); const dir = path.resolve(__dirname,"..","tmp-shots");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1320, height: 900 } });
  for (const [name,route] of [["docs","/docs"],["contacts","/contacts"]]) {
    await p.goto("http://127.0.0.1:5174"+route, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(()=>{});
    await p.waitForTimeout(1500);
    if (name==="docs") { await p.evaluate(()=>{ const h=[...document.querySelectorAll('div')].find(e=>/Подключение весов/.test(e.textContent||'')&&e.style.cursor==='pointer'); if(h) h.click(); }); await p.waitForTimeout(500); }
    await p.screenshot({ path: path.join(dir,"page-"+name+".png"), fullPage: true });
    console.log("shot",name);
  }
  await b.close();
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
