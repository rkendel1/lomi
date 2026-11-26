// Browser smoke test against a running, seeded stack (`docker compose up`).
// Usage: node scripts/ui-smoke.cjs [http://localhost:3000]   (needs Playwright + Chromium installed)
// Checks: sign-in, document list, PDF rendering with evidence highlighting, operations and Schema Studio.
const { chromium } = require('playwright');
const base = process.argv[2] ?? 'http://localhost:3000';
const fail = (msg) => { throw new Error(msg); };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(base);
  await page.getByRole('button', { name: /Riley Reviewer/ }).click();
  await page.waitForSelector('.doc-table tbody tr a');
  const rows = await page.locator('.doc-table tbody tr a').count();
  await page.locator('.doc-table tbody tr a').first().click();
  await page.waitForSelector('article.value');
  await page.waitForFunction(() => (document.querySelector('.pdf-canvas')?.width ?? 0) > 300, null, { timeout: 15000 });
  await page.locator('article.value').first().click();
  await page.waitForTimeout(500);
  const highlighted = await page.evaluate(() => {
    const c = document.querySelector('.pdf-overlay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 150 && d[i + 1] < 220 && d[i + 2] < 60 && d[i + 3] > 0) n++;
    return n;
  });
  if (!highlighted) fail('selected value has no evidence highlight');
  console.log(`reviewer: ${rows} documents, PDF rendered, evidence highlighted (${highlighted} px)`);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: /Olivia Ops/ }).click();
  await page.getByRole('link', { name: 'Operations' }).click();
  await page.waitForSelector('.kpi');
  await page.getByRole('link', { name: 'Schema Studio' }).click();
  await page.waitForSelector('.app-title', { timeout: 15000 });
  console.log(`operator: operations loaded; studio opened "${await page.locator('.app-title').innerText()}"`);
  if (errors.length) fail(`browser errors: ${errors.join(' | ')}`);
  console.log('UI SMOKE PASS');
  await browser.close();
})().catch((e) => { console.error('UI SMOKE FAIL:', e.message); process.exit(1); });
