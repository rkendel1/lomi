import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractPdfText } from '@lomi/pdf/text';
const require = createRequire(import.meta.url);
const { LocalML } = require('@rust-ml-runtime/node');
const ml = await LocalML.create({ modelRoot: '/home/user/.lomi-models' });
const dir = '/home/user/lomi/packages/core/src/__tests__/fixtures';
const expected = JSON.parse(readFileSync(`${dir}/expected-fields.json`, 'utf8'));
const truth: Record<string, string | null> = {
  invoice_number: 'INV-2025-0847', issue_date: '2025-09-14', due_date: '2025-10-14', vendor_name: 'MERIDIAN OFFICE SUPPLIES LLC', total_amount: '$5,230.29',
  tenant_name: 'Dana Okafor', monthly_rent: '$2,350.00', security_deposit: '$3,525.00', lease_start: 'March 1, 2025', term_months: '24',
  report_quarter: 'Q3 2025', market_area: 'Eastport-Harborview Submarket', vacancy_rate: '4.2%', average_rent_1br: '$1,985', year_over_year_rent_growth: '3.8%', median_household_income: null,
};
function passages(lines: string[]): string[] {
  const out: string[] = []; let prose = '';
  const flush = () => { if (prose) { out.push(...prose.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)); prose = ''; } };
  for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
    const isProse = l.length > 45 && (l.match(/\b[a-z]{3,}\b/g) ?? []).length >= 4;
    if (isProse) prose += (prose ? ' ' : '') + l; else { flush(); out.push(l); }
  }
  flush();
  return out.filter((p) => !/^-{5,}$/.test(p));
}
const PAT: Record<string, RegExp> = {
  money: /\$\s?\d[\d,]*(?:\.\d{2})?/g, date: /\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g,
  percent: /\b\d+(?:\.\d+)?%/g, number: /\(\d+\)|\b\d+\b/g,
  string: /(?:[A-Z][A-Za-z0-9&.'-]*|[A-Z0-9]+-[A-Z0-9-]+|Q[1-4])(?:\s+(?:[A-Z0-9][A-Za-z0-9&.'-]*))*/g,
};
const STOP = new Set(['the','this','a','an','and','or','of','to','in','on','for','by','with','is','are','upon','unless','no','one','two','please','payments']);
function spans(p: string, type: string, label: string) {
  const c = new Set<string>();
  const lab = p.match(/^([A-Z][A-Za-z ()%.0-9]{1,40}):\s*(.+)$/);
  const body = lab ? lab[2] : p; // never offer the label itself as a value
  if (type === 'string' && lab) c.add(lab[2].trim());
  for (const m of body.matchAll(PAT[type] ?? PAT.string)) c.add(m[0].replace(/^\((\d+)\)$/, '$1').trim());
  const labelWords = new Set(label.toLowerCase().split(/\s+/));
  return [...c].filter((x) => {
    if (!x) return false;
    const words = x.toLowerCase().split(/\s+/);
    if (type === 'string' && words.every((w) => STOP.has(w.replace(/[^a-z]/g, '')) || labelWords.has(w.replace(/[^a-z]/g, '')))) return false;
    return true;
  });
}
let correct = 0, total = 0;
const docs = [['invoice', 'invoice-001.pdf'], ['lease', 'lease-excerpt-001.pdf'], ['market_report', 'market-report-excerpt-001.pdf']];
for (const [type, file] of docs) {
  const d = await extractPdfText(new Uint8Array(readFileSync(`${dir}/documents/${file}`)));
  const lines: string[] = []; let cur = '';
  for (const it of d.pages[0].items) { cur += it.str; if (it.eol) { lines.push(cur); cur = ''; } }
  if (cur) lines.push(cur);
  const ps = passages(lines);
  const fields = expected[type];
  const HINTS: Record<string, string> = { total_amount: 'final total amount due (not the subtotal)', vacancy_rate: 'current overall vacancy rate' };
  const lab = (f: any) => HINTS[f.field] ?? f.field.replace(/_/g, ' ').replace(/\b1br\b/, 'one-bedroom unit');
  const t0 = Date.now();
  // One call per passage, one yes/no decision per field.
  const scores: number[][] = [];
  for (const p of ps) {
    const r = await ml.decideAsync({ model: 'laya', input: p, decisions: fields.map((f: any, i: number) => ({ name: `f${i}`, instructions: `Does this passage state the ${lab(f)}?`, kind: { type: 'noul' } })) });
    scores.push(fields.map((_: any, i: number) => { const d = r.decisions.find((x: any) => x.name === `f${i}`); return d.probabilities.true ?? 0; }));
  }
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const ranked = ps.map((p, j) => ({ p, s: scores[j][i] })).sort((a, b) => b.s - a.s);
    let value: string | null = null; let used = '';
    // Joint decision: passage score x candidate score over the best few passages.
    let best = { score: 0, c: null as string | null, p: '' };
    for (const { p, s } of ranked.slice(0, 4)) {
      if (s < 0.3) break;
      const cands = spans(p, f.type, lab(f));
      if (!cands.length) continue;
      const r2 = await ml.decideAsync({ model: 'laya', input: p, decisions: cands.map((c, k) => ({ name: `c${k}`, instructions: `Is "${c}" the ${lab(f)}?`, kind: { type: 'noul' } })) });
      for (const [k, c] of cands.entries()) {
        const cs = r2.decisions.find((x: any) => x.name === `c${k}`).probabilities.true;
        if (s * cs > best.score) best = { score: s * cs, c, p };
      }
    }
    if (best.score >= 0.25) { value = best.c; used = best.p; }
    const ok = value === truth[f.field] || (value && truth[f.field] && value.replace(/[$,]/g, '') === truth[f.field]!.replace(/[$,]/g, ''));
    total++; if (ok) correct++;
    console.log(`${ok ? 'OK  ' : 'MISS'} ${f.field.padEnd(28)} -> ${JSON.stringify(value)} top=${ranked[0].s.toFixed(2)} "${ranked[0].p.slice(0, 50)}" | used "${used.slice(0, 40)}"`);
  }
  console.log(`  (${type}: ${ps.length} passages, ${Date.now() - t0} ms)`);
}
console.log(`accuracy ${correct}/${total}`);
