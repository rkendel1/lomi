import type { ExtractionProvider, SemanticValidator } from '@lomi/docops';
import { passages } from '@lomi/docops';
import type { ProviderRegistry } from '../../llm/providers';

/** The correct values in the assignment fixtures (null = not stated in the document). */
export const TRUTH: Record<string, string | null> = {
  'invoice.invoice_number': 'INV-2025-0847',
  'invoice.issue_date': '2025-09-14',
  'invoice.due_date': '2025-10-14',
  'invoice.vendor_name': 'MERIDIAN OFFICE SUPPLIES LLC',
  'invoice.total_amount': '5230.29',
  'lease.tenant_name': 'Dana Okafor',
  'lease.monthly_rent': '2350.00',
  'lease.security_deposit': '3525.00',
  'lease.lease_start': '2025-03-01',
  'lease.term_months': '24',
  'market_report.report_quarter': 'Q3 2025',
  'market_report.market_area': 'Eastport-Harborview Submarket',
  'market_report.vacancy_rate': '4.2%',
  'market_report.average_rent_1br': '1985.00',
  'market_report.year_over_year_rent_growth': '3.8%',
  'market_report.median_household_income': null,
};
/** Raw value spellings as they appear in the PDFs, for the oracle. */
const RAW: Record<string, string> = {
  'invoice.invoice_number': 'INV-2025-0847', 'invoice.issue_date': '2025-09-14', 'invoice.due_date': '2025-10-14',
  'invoice.vendor_name': 'MERIDIAN OFFICE SUPPLIES LLC', 'invoice.total_amount': '$5,230.29',
  'lease.tenant_name': 'Dana Okafor', 'lease.monthly_rent': '$2,350.00', 'lease.security_deposit': '$3,525.00', 'lease.lease_start': 'March 1, 2025', 'lease.term_months': '24',
  'market_report.report_quarter': 'Q3 2025', 'market_report.market_area': 'Eastport-Harborview Submarket', 'market_report.vacancy_rate': '4.2%',
  'market_report.average_rent_1br': '$1,985', 'market_report.year_over_year_rent_growth': '3.8%',
};
const REVISED: Record<string, string> = { 'invoice.due_date': '2025-11-13', 'invoice.total_amount': '$6,126.45' };

/**
 * A stand-in extraction model that knows the right answers and quotes the
 * passage that contains them — or, for `hallucinate`, invents a quote.
 */
export function oracle(options: { hallucinate?: string } = {}): ExtractionProvider {
  return {
    name: 'laya',
    external: false,
    readiness: async () => ({ ready: true, detail: 'oracle' }),
    async extract({ document, fields }) {
      const all = document.pages.flatMap((p) => passages(p).map((text) => ({ text, page: p.pageIndex })));
      const revised = all.some((p) => p.text.includes('(REVISED)'));
      const proposals = fields.map((f) => {
        const raw = (revised && REVISED[f.semanticKey]) || RAW[f.semanticKey];
        if (f.semanticKey === options.hallucinate) return { semanticKey: f.semanticKey, value: 'ACME Corp', quote: 'Vendor: ACME Corp', page: 0, confidence: 0.99 };
        const hit = raw ? all.find((p) => p.text.includes(raw)) : undefined;
        return hit ? { semanticKey: f.semanticKey, value: raw!, quote: hit.text, page: hit.page, confidence: 1 } : { semanticKey: f.semanticKey, value: null, quote: null, page: null };
      });
      return { proposals, model: 'oracle', promptVersion: 'oracle', prompt: 'oracle', rawResponse: JSON.stringify(proposals) };
    },
  };
}
const passingChecks: SemanticValidator = {
  name: 'laya', external: false, readiness: async () => ({ ready: true, detail: 'ok' }),
  async check(_d, checks) {
    return {
      results: checks.map((c) => ({ semanticKey: c.semanticKey, outcome: 'pass' as const, explanation: 'ok', confidence: 0.9 })),
      call: { purpose: 'semantic_validation' as const, provider: 'laya', model: 'fake', promptVersion: 'x', prompt: 'x', rawResponse: 'x' },
      confidenceSource: 'model_probability' as const,
    };
  },
};
export const registry = (extraction: ExtractionProvider): ProviderRegistry => ({ extraction: { laya: extraction }, semantic: { laya: passingChecks }, defaults: { extraction: 'laya', semantic: 'laya' } });

