// One-shot Playwright driver to screenshot the License panel.
// Launches the real Electron app (which loads the Vite dev server at 127.0.0.1:5173),
// dismisses the operator-login gate if present, opens the License tab, and screenshots.
// Run: node scripts/drive-screenshot.cjs   (Vite dev server must already be running)
const { _electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(APP_DIR, 'tmp-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const electronBin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

async function pickPage(app) {
    for (let i = 0; i < 40; i++) {
        const appWin = app.windows().find((w) => w.url().startsWith('http'));
        if (appWin) return appWin;
        await new Promise((r) => setTimeout(r, 500));
    }
    return app.firstWindow();
}

(async () => {
    const app = await _electron.launch({
        executablePath: electronBin,
        args: ['.'],
        cwd: APP_DIR,
        timeout: 60000,
    });
    const page = await pickPage(app);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(7000); // React mount + IPC settle

    await page.screenshot({ path: path.join(SHOT_DIR, '01-landing.png') });

    const gate = await page.evaluate(() => {
        const texts = ['Продолжить без оператора', 'Continue without operator', 'Ohne Bediener fortfahren', 'Продовжити без оператора'];
        const el = [...document.querySelectorAll('button')].find((b) => texts.some((t) => (b.textContent || '').includes(t)));
        if (el) { el.click(); return 'CLICKED'; }
        return 'NO_GATE';
    });
    if (gate === 'CLICKED') await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(SHOT_DIR, '02-after-gate.png') });

    const nav = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const el = btns.find((b) => (b.textContent || '').trim() === 'Лицензия') || btns.find((b) => (b.textContent || '').includes('Лицензия'));
        if (el) { el.click(); return 'CLICKED'; }
        return 'NAV_NOT_FOUND';
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SHOT_DIR, '03-license.png'), fullPage: true });

    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 700));
    console.log('GATE:', gate);
    console.log('NAV:', nav);
    console.log('WINDOWS:', app.windows().map((w) => w.url()));
    console.log('BODY_TEXT_START:\n' + bodyText);

    await app.close();
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
