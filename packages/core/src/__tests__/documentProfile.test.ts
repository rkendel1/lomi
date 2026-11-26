import { detectDocumentProfile } from '../utils/documentProfile';

it('always returns a generic document profile', () => {
  expect(detectDocumentProfile('application.pdf', 'any embedded text')).toEqual({ kind: 'generic' });
});

it('returns a generic profile regardless of filename', () => {
  expect(detectDocumentProfile('some-form.pdf')).toEqual({ kind: 'generic' });
  expect(detectDocumentProfile('other-form.pdf')).toEqual({ kind: 'generic' });
  expect(detectDocumentProfile('intake.pdf', 'Customer intake form')).toEqual({ kind: 'generic' });
});
