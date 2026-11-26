const { chromium } = require('playwright');
// Usage: node scripts/ui-workflows.cjs <dir-for-screenshots> <dir-with-3-unique-invoice-PDFs: invoice-1201.pdf..1203.pdf>
const S = process.argv[2];
const UPL = process.argv[3] ?? `${S}/upl`;
const B = 'http://localhost:3000';
const log = (...a) => console.log(...a);
async function highlightPx(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pdf-overlay');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) n++;
    return n;
  });
}
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // 1. Sign-in: workspaces, no token field. Open via the tenant intake URL.
  await page.goto(`${B}/in/lakeside`);
  await page.getByText('Choose your workspace').waitFor();
  log('token field present:', await page.getByLabel(/API token/i).count());
  await page.screenshot({ path: `${S}/1-signin.png` });

  // 2. Submitter: lands on the intake page; bulk upload of 3 PDFs.
  await page.getByRole('button', { name: /Continue as Pat Payables/ }).click();
  await page.getByRole('heading', { name: /Submit documents to/ }).waitFor();
  log('submitter nav:', (await page.locator('.shell-nav').innerText()).replace(/\s+/g, ' '));
  await page.getByRole('radio', { name: /Vendor invoice/ }).click();
  log('type description:', (await page.locator('.type-fields').innerText()).slice(0, 80));
  await page.locator('input[aria-label="PDF files"]').setInputFiles([`${UPL}/invoice-1201.pdf`, `${UPL}/invoice-1202.pdf`, `${UPL}/invoice-1203.pdf`]);
  const t0 = Date.now();
  await page.getByRole('button', { name: /Submit 3 documents/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.submit-page tbody tr').length === 3);
  await page.waitForFunction(() => [...document.querySelectorAll('.submit-page tbody tr')].every((r) => r.innerText.includes('Ready for review')), null, { timeout: 30000 });
  log(`3 bulk submissions ready for review ${Date.now() - t0} ms after clicking submit`);
  await page.screenshot({ path: `${S}/2-submitted.png` });
  await page.getByRole('button', { name: 'Sign out' }).click();

  // 3. Reviewer: start reviewing, original vs evidence, approve all verified, auto-advance.
  await page.getByRole('button', { name: /Continue as Riley Reviewer/ }).click();
  await page.getByRole('button', { name: /Start reviewing/ }).click();
  await page.waitForSelector('article.value');
  await page.waitForFunction(() => (document.querySelector('.pdf-canvas')?.width ?? 0) > 300);
  await page.waitForTimeout(500);
  const firstUrl = page.url();
  const firstTitle = await page.locator('.page-head h1').innerText();
  log('opened first:', firstTitle);
  log('evidence view highlight px:', await highlightPx(page));
  await page.screenshot({ path: `${S}/3-review-evidence.png` });
  await page.getByRole('tab', { name: 'Original' }).click();
  await page.waitForTimeout(300);
  log('original view highlight px:', await highlightPx(page), '| caption:', await page.locator('.pane-caption').innerText());
  await page.screenshot({ path: `${S}/4-review-original.png` });
  const btn = page.getByRole('button', { name: /Approve all verified/ });
  log('button:', await btn.innerText());
  await btn.click();
  // Either advanced to another document, or fields remain (flagged ones) for individual review.
  await page.waitForTimeout(2000);
  if (page.url() !== firstUrl) {
    log('auto-advanced to:', await page.locator('.page-head h1').innerText(), '| flash:', await page.locator('.flash').innerText());
  } else {
    log('stayed (flagged fields remain):', (await page.locator('.counts').first().innerText()).replace(/\s+/g, ' '));
    // Approve the remaining ones individually: the last approval must advance.
    while (page.url() === firstUrl) {
      const approve = page.locator('article.value-pending button', { hasText: 'Approve' }).first();
      if (!(await approve.count())) break;
      await approve.click();
      await page.waitForTimeout(800);
    }
    log('after last approval:', page.url() !== firstUrl ? `advanced to ${await page.locator('.page-head h1').innerText()}` : 'did not advance');
    if (await page.locator('.flash').count()) log('flash:', await page.locator('.flash').innerText());
  }
  await page.screenshot({ path: `${S}/5-next-document.png` });
  await page.getByRole('button', { name: 'Sign out' }).click();

  // 4. Summit reviewer after Lakeside: no stale customer, no "Not found".
  await page.getByRole('button', { name: /Continue as Sam Reviewer/ }).click();
  await page.getByRole('heading', { name: 'Documents' }).waitFor();
  await page.waitForTimeout(800);
  log('summit errors shown:', await page.locator('.error').count(), '| header customer:', await page.locator('.shell-tenant-name').innerText(), '| rows:', await page.locator('.doc-table tbody tr a').count());
  await page.getByRole('button', { name: 'Sign out' }).click();

  // 5. Operator: customer dropdown in Operations; Studio.
  await page.getByRole('button', { name: /Continue as Olivia Ops/ }).click();
  await page.waitForSelector('.kpi');
  const opts = await page.locator('select[aria-label="Customer scope"] option').allInnerTexts();
  log('operations customer dropdown:', opts.join(' | '));
  await page.selectOption('select[aria-label="Customer scope"]', 'summit');
  await page.waitForTimeout(800);
  log('after choosing Summit, header customer:', await page.locator('select[aria-label="Customer"]').inputValue());
  await page.screenshot({ path: `${S}/6-operations.png` });
  await page.selectOption('select[aria-label="Customer"]', 'lakeside');
  await page.getByRole('link', { name: 'Schema Studio' }).click();
  await page.waitForSelector('.studio-bar');
  await page.selectOption('select[aria-label="Document type"]', 'invoice');
  await page.waitForSelector('.mapper-toolbar', { timeout: 15000 });
  await page.waitForTimeout(2000);
  log('studio crumbs:', (await page.locator('.studio-crumbs').innerText()).replace(/\s+/g, ' '));
  log('standalone mapper header present:', await page.locator('.app-header').count());
  await page.screenshot({ path: `${S}/7-studio-fields.png` });
  await page.getByRole('tab', { name: /Rules/ }).click();
  log('rules:', (await page.locator('.rules .list').first().innerText()).replace(/\s+/g, ' '));
  await page.screenshot({ path: `${S}/8-studio-rules.png` });

  // 6. API reference
  await page.goto(`${B}/api/docs`);
  await page.waitForSelector('text=Lomi Document Operations API', { timeout: 20000 });
  log('api docs rendered');
  await page.screenshot({ path: `${S}/9-api-docs.png` });
  log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
