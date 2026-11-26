import React from 'react';
import { render, screen } from '@testing-library/react';
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

test('the application asks unauthenticated users to sign in', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ users: [] }), { status: 200 })));
  render(<App />);
  expect(await screen.findByText('Lomi Document Operations')).toBeInTheDocument();
  expect(screen.getByLabelText('API token')).toBeInTheDocument();
  vi.unstubAllGlobals();
});
