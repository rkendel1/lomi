import { describe, expect, it } from 'vitest';
import { demoStatus, startDemo } from '../../seed/demo';
import { drain, OPERATOR, q, setup } from './harness';

describe('demo workload', () => {
  it('loads two demo customers whose documents cover every scenario, through the real intake and worker', async () => {
    const ctx = await setup();
    startDemo(ctx, OPERATOR);
    // Act as the worker until the run (which waits for processing) has finished.
    for (let i = 0; i < 600 && demoStatus()?.status === 'running'; i++) {
      await drain(ctx);
      await new Promise((r) => setTimeout(r, 100));
    }
    await drain(ctx);
    const run = demoStatus()!;
    expect(run.error).toBeNull();
    expect(run.status).toBe('done');
    expect(run.submitted).toBeGreaterThan(100);

    const count = async (sql: string) => (await q(ctx, sql))[0].n as number;
    const demo = `t.slug LIKE '%-demo'`;
    const base = `FROM documents d JOIN tenants t ON t.id = d.tenant_id JOIN document_versions dv ON dv.id = d.current_version_id WHERE ${demo}`;
    expect(await count(`SELECT count(*)::int n FROM tenants t WHERE ${demo}`)).toBe(2);
    expect(await count(`SELECT count(*)::int n ${base} AND dv.processing_status = 'failed_operator'`)).toBe(3); // unreadable uploads
    expect(await count(`SELECT count(*)::int n ${base} AND dv.processing_status = 'needs_type'`)).toBeGreaterThanOrEqual(5); // packing slips (+ untyped, fake Laya never decides)
    expect(await count(`SELECT count(*)::int n ${base} AND d.type_source = 'layout'`)).toBe(36); // fixed-layout forms identified without a model
    expect(await count(`SELECT count(DISTINCT vr.document_version_id)::int n FROM validation_results vr JOIN tenants t ON t.id = vr.tenant_id WHERE ${demo} AND vr.rule_id = 'cross.totals' AND vr.outcome = 'fail'`)).toBe(8);
    expect(await count(`SELECT count(DISTINCT vr.document_version_id)::int n FROM validation_results vr JOIN tenants t ON t.id = vr.tenant_id WHERE ${demo} AND vr.rule_id = 'cross.dates' AND vr.outcome = 'fail'`)).toBe(5);
    expect(await count(`SELECT count(*)::int n FROM document_relations r JOIN tenants t ON t.id = r.tenant_id WHERE ${demo}`)).toBe(5); // possible duplicates
    expect(await count(`SELECT count(*)::int n FROM submissions s JOIN tenants t ON t.id = s.tenant_id WHERE ${demo} AND s.outcome = 'duplicate_exact'`)).toBe(8);
    expect(await count(`SELECT count(*)::int n FROM generated_documents g JOIN tenants t ON t.id = g.tenant_id WHERE ${demo} AND g.status = 'succeeded'`)).toBe(9);
    expect(await count(`SELECT count(*)::int n FROM extracted_values ev JOIN tenants t ON t.id = ev.tenant_id WHERE ${demo} AND ev.review_state = 'carried_over'`)).toBeGreaterThan(20);
    // Reviews are attributed to the demo reviewer, not the operator.
    expect(await count(`SELECT count(*)::int n FROM review_decisions rd JOIN principals p ON p.id = rd.actor_principal_id JOIN tenants t ON t.id = rd.tenant_id WHERE ${demo} AND p.display_name = 'Dana Demo (reviewer)'`)).toBeGreaterThan(100);
  }, 180_000);
});
