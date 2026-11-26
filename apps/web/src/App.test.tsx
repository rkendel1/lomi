import React from 'react';
import { render, screen, within } from '@testing-library/react';
import App from './App';
import { Mapper } from './components/studio/Mapper';

// The original coordtool mapper still works standalone.
test('renders PDF Field Mapper title', () => {
  render(<Mapper />);
  expect(screen.getByText(/PDF Field Mapper/i)).toBeInTheDocument();
});

test('renders upload prompt', () => {
  render(<Mapper />);
  expect(screen.getByText(/Upload a PDF Form/i)).toBeInTheDocument();
});

test('Mapper shows Schema Studio header controls when embedded', () => {
  render(<Mapper title="Invoice · template v2" headerExtra={<button>Save draft</button>} />);
  expect(screen.getByText('Invoice · template v2')).toBeInTheDocument();
  expect(screen.getByText('Save draft')).toBeInTheDocument();
});

test('sign-in asks the user to choose a workspace, without an API token field', async () => {
  const users = [
    { name: 'Olivia Ops (Lomi operator)', email: 'o@x', operator: true, experience: 'operations', token: 't1', tenants: [], roles: [] },
    { name: 'Riley Reviewer (Lakeside)', email: 'r@x', operator: false, experience: 'review', token: 't2', tenants: ['lakeside'], roles: ['reviewer'] },
    { name: 'Pat Payables (Lakeside submitter)', email: 'p@x', operator: false, experience: 'submission', token: 't3', tenants: ['lakeside'], roles: ['submitter'] },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ users }), { status: 200 })));
  render(<App />);
  expect(await screen.findByText('Choose your workspace')).toBeInTheDocument();
  for (const title of ['Lomi Operations', 'Customer review', 'Document submission']) {
    expect(screen.getByRole('region', { name: title })).toBeInTheDocument();
  }
  expect(await screen.findByRole('button', { name: /Continue as Pat Payables/ })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Document submission' })).getByText(/Continue as Pat Payables/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/API token/i)).toBeNull();
  vi.unstubAllGlobals();
});
