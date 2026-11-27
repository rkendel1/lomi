/**
 * Demo identities created by the seed script. Their tokens are well-known
 * development values (stored hashed like any token) and are listed by
 * `GET /api/auth/dev-users` only when LOMI_DEV_LOGIN=1. Never enable that in
 * production, and never seed these identities into a production database.
 */
export interface DevIdentity {
  key: string;
  name: string;
  email: string;
  kind: 'user' | 'agent';
  operator: boolean;
  /** The experience this identity demonstrates on the sign-in screen. */
  experience: 'operations' | 'admin' | 'review' | 'submission' | 'agent';
  token: string;
  memberships: Array<{ tenant: string; role: string; delegatedBy?: string; scopes?: string[] }>;
}

export const DEV_IDENTITIES: DevIdentity[] = [
  { key: 'operator', name: 'Olivia Ops (Lomi operator)', email: 'olivia@lomi.example', kind: 'user', operator: true, experience: 'operations', token: 'dev-operator', memberships: [] },
  { key: 'acme-admin', name: 'Avery Admin (Lakeside admin)', email: 'avery@lakeside.example', kind: 'user', operator: false, experience: 'admin', token: 'dev-lakeside-admin', memberships: [{ tenant: 'lakeside', role: 'customer_admin' }] },
  { key: 'acme-reviewer', name: 'Riley Reviewer (Lakeside)', email: 'riley@lakeside.example', kind: 'user', operator: false, experience: 'review', token: 'dev-lakeside-reviewer', memberships: [{ tenant: 'lakeside', role: 'reviewer' }] },
  { key: 'summit-reviewer', name: 'Sam Reviewer (Summit Realty)', email: 'sam@summit.example', kind: 'user', operator: false, experience: 'review', token: 'dev-summit-reviewer', memberships: [{ tenant: 'summit', role: 'reviewer' }] },
  {
    key: 'acme-submitter', name: 'Pat Payables (Lakeside submitter)', email: 'pat@lakeside.example', kind: 'user', operator: false, experience: 'submission',
    token: 'dev-lakeside-submitter', memberships: [{ tenant: 'lakeside', role: 'submitter' }],
  },
  {
    key: 'acme-agent', name: 'Review assistant (agent for Riley)', email: 'agent@lakeside.example', kind: 'agent', operator: false, experience: 'agent', token: 'dev-lakeside-agent',
    memberships: [{ tenant: 'lakeside', role: 'agent', delegatedBy: 'acme-reviewer', scopes: ['documents.read', 'provenance.read', 'reviews.propose', 'reviews.decide'] }],
  },
];
