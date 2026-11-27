# Session 04 — Customer onboarding, quick forms, roles, type detection with Laya

Sanitized engineering log of the fourth coding-agent session (Claude Code,
cloud sandbox). No secrets were used.

## Reported problems

1. "Add new customer doesn't work in the operator role."
2. An operator needs to be able to add a new form easily.
3. Admin and other customer roles look the same.
4. The submitter needs a better submission experience.
5. Submitting should use Laya to determine the type of document.

## Findings before changing anything

- **Add customer**: the capability itself worked, but any short name with a
  capital letter, a space or a single character violated the database's
  `tenants_slug_check` and the operator saw "Internal error". On success the
  form only cleared: the new customer did not appear in the table, was not
  selected, and nothing pointed to the next steps.
- **Forms**: a new type was hidden in a dropdown option, and then needed a base
  PDF, fields drawn on it, extraction settings per field, and a publish.
- **Roles**: the customer admin and the reviewer used the same "Review"
  workspace; the only difference was an Operations link.
- **Submission**: a type had to be picked before upload, and the list showed
  only files sent in the current browser session.
- **Type**: fixed at submission (explicit or ingress default); the database
  required it.

## What changed

- `tenants.create` validates name and short name with a clear message; the UI
  derives the short name from the name, shows the intake URL, switches to the
  new customer and links to *add its first form* and *add its people*.
- **Quick form setup** (`templates.forms.create`, Schema Studio → *New form*):
  name, description, and rows of label / kind of value / what to look for.
  Lomi generates the output form and template (fields read by the extraction
  model from their instructions) and publishes it. Everything is validated
  before anything is written. The seed's fixture templates now use the same
  field builder.
- **Type detection** (migration `003`): `documents.document_type_id` may be
  null with `type_source = 'pending'`; new status `needs_type`. The worker
  identifies the type after parsing (`LayaDocumentClassifier`, one call, one
  yes/no question per published type; deterministic thresholds in
  `decideType`), records scores on the document and the call in `model_calls`
  (purpose `classification`), or holds the document for a person.
  `documents.type.set` resumes processing.
- **Customer admin workspace** ("Admin"): lands on Operations; **Team** page
  (`members.list/add/role.change/remove`, permission `members.manage`). A new
  person gets a sign-in token shown once; the last admin cannot be removed or
  demoted; removing a person removes agents delegated by them. The login page
  accepts a token. Operators see Team for any customer (a new customer has no
  people yet).
- **Submitter**: "Identify automatically" is the default; *What you've sent*
  lists everything the person sent (`documents.list {mine: true}`) with type,
  how it was decided, status and what happens next; unclear documents ask the
  sender.

## Measured

Laya prototype on the fixtures, before wiring it in (P(yes) per type):

| File | invoice | lease | market report |
| --- | --- | --- | --- |
| invoice-001.pdf | 0.99 | 0.00 | 0.04 |
| invoice-001.v2.pdf | 0.99 | 0.00 | 0.00 |
| lease-excerpt-001.pdf | 0.06 | 1.00 | 0.02 |
| market-report-excerpt-001.pdf | 0.00 | 0.18 | 0.96 |

## Verified

- `pnpm test` with `LAYA_TEST_MODEL_DIR` set: all packages pass, including the
  real-model tests (fixture extraction; every fixture identified without a type).
- New integration tests (`detection.test.ts`): detection, ambiguity → person,
  single type without a model call, no classifier → person, quick form,
  short-name validation, team rules.
- Browser run against the live stack with the real model: operator creates a
  customer by name, adds two forms, adds an admin and a submitter; the submitter
  signs in with the token and sends three unlabeled PDFs: invoice and lease
  identified (0.99, 1.00) and extracted correctly (7/7 values); the market
  report (no matching form) was held and processed after the submitter chose.
  The new admin lands in the Admin workspace. `scripts/ui-smoke.cjs` passes.

## Not done / known limits

- A type can be chosen only while the document waits for one; a wrongly
  identified, already-processed document must be re-sent.
- Quick forms create model-read fields only (no pattern fields, no cross-field
  rules); refine those in Schema Studio.
- Quick form setup writes the type, base PDF, draft and publish as separate
  transactions after validating everything; a failure between them (e.g. the
  database going down) can leave a type without a published template.
- Sign-in tokens are the only sign-in for added people (no SSO or email invite).
