// Verify the route-protection guard: an unauthenticated visit to a protected route
// must redirect to /login. Read-only — creates no accounts, enters no credentials.
const { chromium } = require("playwright-core");
(async () => {
  const b = await chromium.launch({ channel: "msedge", headless: true });
  const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
  for (const route of ["/account", "/admin", "/account/buy"]) {
    await p.goto("http://127.0.0.1:5174" + route, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(1600);
    const url = p.url();
    const onLogin = await p.evaluate(() => /Вход|Войти|войдите/i.test(document.body.innerText));
    console.log(route, "->", url.replace("http://127.0.0.1:5174", ""), onLogin ? "[login page]" : "[NOT login]");
  }
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
