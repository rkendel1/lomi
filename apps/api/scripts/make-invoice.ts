// Writes a fictional invoice PDF (from the seed fixtures) to stdout. Usage: tsx scripts/make-invoice.ts INV-2026-0999
import { INVOICE_V1, invoicePdf } from '../src/seed/fixtures';
const number = process.argv[2] ?? 'INV-2026-0999';
process.stdout.write(Buffer.from(await invoicePdf({ ...INVOICE_V1, number })));
