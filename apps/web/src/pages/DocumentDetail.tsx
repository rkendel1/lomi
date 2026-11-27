import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { Field } from '@lomi/core';
import { PDFViewer } from '../components/PDFViewer';
import { MapIntoForm } from '../components/ops/MapIntoForm';
import { call, can, fetchPdf, type Me } from '../lib/client';
import { ProgressCounts, StatusBadge, STATE_LABELS, TypeChooser, TypeTag, type Progress, type TypeInfo } from './shared';

pdfjsLib.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

interface Check { ruleId: string; method: string; outcome: string; explanation: string; model: string | null; confidence: number | null; confidenceSource: string | null }
interface Decision { id: string; action: string; oldValue: string | null; newValue: string | null; note: string | null; actor: string; actorKind: string; at: string }
export interface ValueView {
  id: string;
  semanticKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  method: string;
  value: string | null;
  normalizedValue: string | null;
  finalValue: string | null;
  state: 'pending' | 'gap' | 'approved' | 'auto_approved' | 'corrected' | 'carried_over';
  needsAttention: boolean;
  attentionReason: string | null;
  gapReason: string | null;
  unverified: { value: string | null; quote: string | null } | null;
  evidence: { page: number; quote: string; box: { x: number; y: number; width: number; height: number } | null } | null;
  previous: null | { value: string | null; finalValue: string | null; reviewState: string; evidence: { page: number; quote: string } | null; changeReasons: string[]; carriedOver: boolean };
  checks: Check[];
  decisions: Decision[];
  proposals: Array<{ id: string; proposedValue: string | null; rationale: string; proposedBy: string }>;
}

interface DocumentView {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  nextAction: string;
  failureReason: string | null;
  warning: string | null;
  progress: Progress | null;
  documentType: { key: string; name: string } | null;
  typeSource: string;
  classification: TypeInfo['classification'];
  currentVersion: { id: string; number: number };
  viewing: { versionId: string; number: number; isCurrent: boolean; processingStatus: string; templateVersion: number | null; pageCount: number | null; filename: string; sha256: string };
  versions: Array<{ id: string; number: number; filename: string; processingStatus: string; failureReason: string | null; templateVersion: number | null; receivedAt: string; processedAt: string | null; sha256: string }>;
  values: ValueView[];
  generated: Array<{ id: string; status: string; sha256: string | null; templateVersion: number; documentVersion: number; error: string | null; createdAt: string }>;
  related: Array<{ documentId: string; title: string; reason: string }>;
  receipts: { total: number; revisions: number; identicalResends: number; resendChannels: string[] };
  receiptLog: Array<{ at: string; outcome: string; label: string; channel: string; filename: string; sha256: string; submittedBy: string | null }>;
  history: Array<{ at: string; action: string; actor: string; actorKind: string; detail: Record<string, unknown> }>;
}

const IN_FLIGHT = ['received', 'queued', 'parsing', 'extracting', 'validating', 'failed_retryable'];
const display = (v: ValueView) => v.finalValue ?? v.normalizedValue ?? v.value;

export const DocumentDetail: React.FC<{ tenant: string; documentId: string; me: Me }> = ({ tenant, documentId, me }) => {
  const [doc, setDoc] = useState<DocumentView | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'values' | 'versions' | 'receipts' | 'history' | 'outputs'>('values');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extending, setExtending] = useState(false);
  const [view, setView] = useState<'evidence' | 'original'>('evidence');
  const [flash, setFlash] = useState<string | null>(() => {
    try {
      const f = sessionStorage.getItem('lomi.flash');
      sessionStorage.removeItem('lomi.flash');
      return f;
    } catch {
      return null;
    }
  });

  const load = useCallback(async (): Promise<DocumentView | null> => {
    try {
      const d = await call<DocumentView>('documents.get', { tenant, documentId, ...(versionId ? { versionId } : {}) });
      setDoc(d);
      setError(null);
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [tenant, documentId, versionId]);

  useEffect(() => void load(), [load]);

  // Open on the first field that needs a decision, with its evidence highlighted.
  useEffect(() => {
    if (!doc || selected) return;
    const first = doc.values.find((v) => v.needsAttention) ?? doc.values[0];
    if (first) {
      setSelected(first.id);
      if (first.evidence) setPage(first.evidence.page + 1);
    }
  }, [doc, selected]);
  useEffect(() => {
    if (!doc) return;
    const pendingOutput = doc.generated.some((g) => g.status === 'pending');
    if (!IN_FLIGHT.includes(doc.viewing.processingStatus) && !pendingOutput) return;
    const t = setTimeout(() => void load(), 1500);
    return () => clearTimeout(t);
  }, [doc, load]);

  const viewingId = doc?.viewing.versionId;
  useEffect(() => {
    if (!viewingId) return;
    let cancelled = false;
    void fetchPdf(`/api/documents/${documentId}/file?versionId=${viewingId}`, tenant, 'original.pdf').then((f) => !cancelled && setFile(f)).catch(() => setFile(null));
    return () => { cancelled = true; };
  }, [viewingId, documentId, tenant]);

  // Evidence boxes rendered by coordtool's PDF viewer (read-only).
  const evidenceFields = useMemo<Field[]>(
    () =>
      (view === 'original' ? [] : (doc?.values ?? []).filter((v) => v.id === selected))
        .filter((v) => v.evidence?.box)
        .map((v) => ({
          id: v.id, name: v.semanticKey, sourceFieldId: v.semanticKey, semanticKey: v.semanticKey, displayLabel: v.label,
          page: v.evidence!.page, x: v.evidence!.box!.x - 2, y: v.evidence!.box!.y - 3, width: v.evidence!.box!.width + 4, height: v.evidence!.box!.height + 5,
          type: 'text' as const,
        })),
    [doc, view, selected]
  );

  const select = (v: ValueView) => {
    setSelected(v.id);
    if (v.evidence) setPage(v.evidence.page + 1);
  };

  /** When a document has nothing left to decide, open the next one waiting for review straight away. */
  const advance = async (finished: DocumentView) => {
    const next = await call<{ documentId: string | null; title: string | null; remaining: number }>('documents.next', { tenant, after: documentId });
    const done = `“${finished.title}” is fully reviewed${finished.status === 'approved' ? ' and approved' : ''}.`;
    if (next.documentId) {
      try {
        sessionStorage.setItem('lomi.flash', `${done} Now reviewing “${next.title}” (${next.remaining} waiting).`);
      } catch {
        /* the note is optional */
      }
      window.location.hash = `/documents/${next.documentId}`;
    } else {
      setFlash(`${done} Nothing else is waiting for review.`);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const wasOpen = doc?.progress ? doc.progress.pending + doc.progress.gaps : 0;
      await fn();
      const d = await load();
      if (d && d.viewing.isCurrent && wasOpen > 0 && d.progress && d.progress.pending + d.progress.gaps === 0) await advance(d);
      else if (d) {
        // Move the selection to the next field that still needs a decision.
        const next = [...d.values].find((v) => v.needsAttention);
        if (next) {
          setSelected(next.id);
          if (next.evidence) setPage(next.evidence.page + 1);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!doc) return <div className="page">{error ? <div className="error">{error}</div> : 'Loading…'}</div>;
  const canReview = can(me, tenant, 'reviews.decide') && doc.viewing.isCurrent && doc.viewing.processingStatus === 'processed';
  const ordered = [...doc.values].sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));
  const verifiedCount = doc.values.filter(
    (v) => v.needsAttention && v.state !== 'gap' && v.evidence && !v.checks.some((c) => ['fail', 'uncertain', 'error'].includes(c.outcome))
  ).length;
  const openCount = doc.progress ? doc.progress.pending + doc.progress.gaps : 0;
  const latestOutput = doc.generated.find((g) => g.documentVersion === doc.currentVersion.number && g.status === 'succeeded');

  return (
    <div className="page detail">
      <div className="page-head">
        <div>
          <a href="#/documents" className="back">← Documents</a>
          <h1>{doc.title}</h1>
          <p className="muted">
            <TypeTag doc={doc} /> · version {doc.viewing.number}
            {!doc.viewing.isCurrent && <strong className="warn-text"> (older version — read only)</strong>}
            {doc.viewing.templateVersion && ` · template v${doc.viewing.templateVersion}`}
          </p>
        </div>
        <div className="head-status">
          <StatusBadge status={doc.status} label={doc.statusLabel} />
          <div className="next">Next: <strong>{doc.nextAction}</strong></div>
          {doc.failureReason && <div className="error small">{doc.failureReason}</div>}
          <div className="head-actions">
            {doc.status === 'failed_operator' && can(me, tenant, 'documents.retry') && (
              <button className="btn-primary" disabled={busy} onClick={() => act(() => call('documents.retry', { tenant, documentId }))}>Retry processing</button>
            )}
            {doc.status === 'approved' && can(me, tenant, 'documents.generate') && (
              <button className="btn-primary" disabled={busy} onClick={() => act(() => call('documents.generate', { tenant, documentId }))}>Generate output</button>
            )}
            {latestOutput && (
              <button onClick={() => void fetchPdf(`/api/documents/${documentId}/file?output=${latestOutput.id}`, tenant, 'output.pdf').then((f) => window.open(URL.createObjectURL(f)))}>Download output</button>
            )}
            <button onClick={() => file && window.open(URL.createObjectURL(file))} disabled={!file}>Original PDF</button>
            {me.operator && doc.documentType && doc.viewing.isCurrent && doc.viewing.processingStatus === 'processed' && (
              <button onClick={() => setExtending((v) => !v)}>{extending ? 'Close' : 'Capture more…'}</button>
            )}
          </div>
        </div>
      </div>
      {flash && <div className="flash" role="status">{flash}</div>}
      {extending && doc.documentType && (
        <MapIntoForm tenant={tenant} documentId={documentId} file={file} currentType={doc.documentType.key} onDone={() => { setExtending(false); void load(); }} />
      )}
      {doc.status === 'needs_type' && me.operator && (
        <MapIntoForm tenant={tenant} documentId={documentId} file={file} classification={doc.classification as any} onDone={() => void load()} />
      )}
      {doc.status === 'needs_type' && !me.operator && can(me, tenant, 'documents.submit') && (
        <section className="card card-action">
          <h2>What kind of document is this?</h2>
          <TypeChooser tenant={tenant} documentId={documentId} reason={doc.failureReason} scores={doc.classification?.scores} onChosen={() => void load()} />
        </section>
      )}
      {doc.warning && <div className="error">{doc.warning}</div>}
      {(doc.related.length > 0 || doc.receipts.identicalResends > 0 || doc.receipts.revisions > 0) && (
        <div className="dup-banner" role="note">
          {doc.related.length > 0 && (
            <div className="dup-line dup-warn">
              <strong>Possible duplicate.</strong>{' '}
              {doc.related.map((r, i) => (
                <span key={r.documentId}>{i > 0 && ', '}<a href={`#/documents/${r.documentId}`}>{r.title}</a></span>
              ))}{' '}
              — {doc.related[0].reason} Not merged: check whether this is the same transaction before approving.
            </div>
          )}
          {doc.receipts.identicalResends > 0 && (
            <div className="dup-line">
              <strong>Re-sent {doc.receipts.identicalResends}×.</strong> The identical file arrived again ({doc.receipts.resendChannels.join(', ')}); each receipt is recorded and nothing was reprocessed.
            </div>
          )}
          {doc.receipts.revisions > 0 && (
            <div className="dup-line">
              <strong>Revised {doc.receipts.revisions}×.</strong> This is version {doc.currentVersion.number}; reviews whose evidence did not change were carried over.
            </div>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="detail-body">
        <section className={`detail-viewer view-${view}`} aria-label={view === 'original' ? 'Original document' : 'Evidence view'}>
          <div className="pane-head">
            <div className="seg-control" role="tablist" aria-label="Document view">
              <button role="tab" aria-selected={view === 'original'} className={view === 'original' ? 'active' : ''} onClick={() => setView('original')}>Original</button>
              <button role="tab" aria-selected={view === 'evidence'} className={view === 'evidence' ? 'active' : ''} onClick={() => setView('evidence')}>Evidence</button>
            </div>
            <span className="pane-caption">
              {view === 'original'
                ? `As received · version ${doc.viewing.number} · ${doc.viewing.filename} · unmodified`
                : (() => {
                    const v = doc.values.find((x) => x.id === selected);
                    return v?.evidence ? `Where “${v.label}” was found (page ${v.evidence.page + 1})` : v ? `“${v.label}” has no evidence in this document` : 'Select a field to see where it was found';
                  })()}
            </span>
          </div>
          {file ? (
            <PDFViewer
              file={file}
              fields={evidenceFields}
              selectedId={selected}
              debugMode={false}
              defaultType="text"
              currentPage={page}
              totalPages={doc.viewing.pageCount ?? 1}
              gridSize={0}
              enableOCR={false}
              enableAutoDetect={false}
              documentProfile={{ kind: 'generic' }}
              onPageChange={setPage}
              onFieldAdded={() => undefined}
              onFieldSelected={(id) => {
                const v = doc.values.find((x) => x.id === id);
                if (v) select(v);
              }}
              readOnly
              highlightColor="rgba(255, 196, 0, 0.45)"
              showFieldOverlays={view === 'evidence'}
            />
          ) : (
            <div className="empty">Loading document…</div>
          )}
        </section>

        <section className="detail-side" aria-label="Review">
          <div className="pane-head review-head">
            <div>
              <h2>Review</h2>
              {doc.progress && <ProgressCounts progress={doc.progress} />}
            </div>
            {canReview && openCount > 0 && (
              <button className="btn-primary" disabled={busy || verifiedCount === 0} title="Approves each pending field whose evidence was verified and whose checks raised nothing. Flagged and missing fields stay for you." onClick={() => act(() => call('values.verified.approve', { tenant, documentId }))}>
                Approve all verified ({verifiedCount})
              </button>
            )}
            {canReview && openCount === 0 && doc.status !== 'completed' && (
              <button onClick={() => void advance(doc)}>Next document →</button>
            )}
          </div>
          <div className="tabs" role="tablist">
            {(['values', 'versions', 'receipts', 'history', 'outputs'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'values' ? `Fields (${doc.values.length})` : t === 'receipts' ? `Receipts (${doc.receipts.total})` : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'values' && (
            <div className="values">
              {IN_FLIGHT.includes(doc.viewing.processingStatus) && <div className="notice">{doc.statusLabel}…</div>}
              {ordered.map((v) => (
                <ValueCard
                  key={v.id}
                  value={v}
                  selected={selected === v.id}
                  onSelect={() => select(v)}
                  canReview={canReview}
                  busy={busy}
                  onApprove={(note) => act(() => call('values.review', { tenant, valueId: v.id, action: 'approve', ...(note ? { note } : {}) }))}
                  onCorrect={(value, note, proposalId) =>
                    act(() => call('values.review', { tenant, valueId: v.id, action: 'correct', value, ...(note ? { note } : {}), ...(proposalId ? { proposalId } : {}) }))
                  }
                />
              ))}
            </div>
          )}

          {tab === 'versions' && (
            <ul className="list">
              {doc.versions.map((v) => (
                <li key={v.id} className={v.id === doc.viewing.versionId ? 'current' : ''}>
                  <button className="btn-link" onClick={() => setVersionId(v.id === doc.currentVersion.id ? null : v.id)}>Version {v.number}</button>{' '}
                  <span className="muted">{v.filename} · {new Date(v.receivedAt).toLocaleString()} · {v.processingStatus}{v.templateVersion ? ` · template v${v.templateVersion}` : ''}</span>
                  {v.failureReason && <div className="error small">{v.failureReason}</div>}
                  <div className="mono small muted">sha256 {v.sha256.slice(0, 16)}…</div>
                </li>
              ))}
            </ul>
          )}

          {tab === 'receipts' && (
            <ul className="list">
              {doc.receiptLog.map((r, i) => (
                <li key={i} className={`receipt receipt-${r.outcome}`}>
                  <strong>{r.label}</strong>
                  <div className="small muted">
                    {new Date(r.at).toLocaleString()} · {r.channel === 'api' ? 'electronic (API)' : r.channel === 'bulk' ? 'bulk upload' : 'upload'} · {r.filename}
                    {r.submittedBy && ` · ${r.submittedBy}`}
                  </div>
                  <div className="mono small muted">sha256 {r.sha256.slice(0, 16)}…</div>
                </li>
              ))}
            </ul>
          )}

          {tab === 'history' && (
            <ol className="list history">
              {doc.history.map((h, i) => (
                <li key={i}>
                  <span className="muted small">{new Date(h.at).toLocaleString()}</span> <strong>{h.actor}</strong> {h.action.replace(/[._]/g, ' ')}
                  {typeof h.detail.semanticKey === 'string' && <span> — {h.detail.semanticKey}: {String(h.detail.oldValue ?? '∅')} → {String(h.detail.newValue ?? '∅')}</span>}
                  {typeof h.detail.reason === 'string' && <div className="small">{h.detail.reason}</div>}
                </li>
              ))}
            </ol>
          )}

          {tab === 'outputs' && (
            <ul className="list">
              {doc.generated.length === 0 && <li className="muted">No outputs yet. Outputs are generated from approved values.</li>}
              {doc.generated.map((g) => (
                <li key={g.id}>
                  <strong>{g.status}</strong> · from document v{g.documentVersion} with template v{g.templateVersion} · {new Date(g.createdAt).toLocaleString()}
                  {g.sha256 && <div className="mono small muted">sha256 {g.sha256.slice(0, 16)}…</div>}
                  {g.error && <div className="error small">{g.error}</div>}
                  {g.status === 'succeeded' && (
                    <div className="row-actions">
                      <button onClick={() => void fetchPdf(`/api/documents/${documentId}/file?output=${g.id}`, tenant, 'output.pdf').then((f) => window.open(URL.createObjectURL(f)))}>Download</button>
                      <button onClick={() => void call('documents.outputs.verify', { tenant, generatedDocumentId: g.id }).then((r) => alert(r.reproducible ? 'Re-rendered from recorded inputs: byte-identical.' : `Not reproducible: ${r.reason ?? 'hash differs'}`))}>
                        Verify reproducible
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

const ValueCard: React.FC<{
  value: ValueView;
  selected: boolean;
  onSelect: () => void;
  canReview: boolean;
  busy: boolean;
  onApprove: (note: string) => void;
  onCorrect: (value: string, note: string, proposalId?: string) => void;
}> = ({ value: v, selected, onSelect, canReview, busy, onApprove, onCorrect }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display(v) ?? '');
  const [note, setNote] = useState('');
  const issues = v.checks.filter((c) => c.outcome === 'fail' || c.outcome === 'uncertain' || c.outcome === 'error');
  const passed = v.checks.filter((c) => c.outcome === 'pass').length;

  return (
    <article className={`value value-${v.state}${selected ? ' selected' : ''}`} onClick={onSelect} aria-label={v.label}>
      <header>
        <span className="value-label">{v.label}{v.required && <span className="req" title="Required">*</span>}</span>
        <span className={`state state-${v.state}`}>{STATE_LABELS[v.state]}</span>
      </header>
      <div className="value-main">
        <span className="value-text">{display(v) ?? <em className="muted">no value</em>}</span>
        {v.finalValue && v.normalizedValue && v.finalValue !== v.normalizedValue && <span className="muted small"> (extracted: {v.normalizedValue})</span>}
      </div>
      {v.needsAttention && v.attentionReason && <div className="attention">{v.attentionReason}</div>}
      {v.evidence ? (
        <blockquote className="evidence" title="Verified verbatim in the document">“{v.evidence.quote}” <span className="muted small">p.{v.evidence.page + 1}</span></blockquote>
      ) : v.unverified?.quote ? (
        <div className="small warn-text">The model claimed “{v.unverified.quote}”, which is not in the document; the value was not accepted.</div>
      ) : null}
      {v.previous && (
        <div className={`previous ${v.previous.carriedOver ? 'carried' : 'changed'}`}>
          {v.previous.carriedOver ? 'Unchanged from the previous version; its review was carried over.' : (
            <>
              <div>Previously <strong>{v.previous.finalValue ?? v.previous.value ?? '∅'}</strong> ({v.previous.reviewState})</div>
              {v.previous.evidence && <div className="small muted">was: “{v.previous.evidence.quote}”</div>}
            </>
          )}
        </div>
      )}
      {(issues.length > 0 || passed > 0) && (
        <ul className="checks">
          {issues.map((c, i) => (
            <li key={i} className={`check-${c.outcome}`}>{c.method === 'semantic' ? `Model check (${c.model ?? 'n/a'})` : 'Check'}: {c.explanation}</li>
          ))}
          {passed > 0 && <li className="check-pass">{passed} check{passed === 1 ? '' : 's'} passed</li>}
        </ul>
      )}
      {v.proposals.map((p) => (
        <div key={p.id} className="proposal">
          <span>{p.proposedBy} suggests <strong>{p.proposedValue ?? '∅'}</strong>: {p.rationale}</span>
          {canReview && <button disabled={busy} onClick={(e) => { e.stopPropagation(); onCorrect(p.proposedValue ?? '', `Accepted suggestion: ${p.rationale}`, p.id); }}>Accept</button>}
        </div>
      ))}
      {canReview && v.needsAttention && (
        <div className="review" onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <>
              <input aria-label={`Corrected ${v.label}`} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
              <input aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn-primary" disabled={busy} onClick={() => onCorrect(draft, note)}>Save correction</button>
              <button className="btn-link" onClick={() => setEditing(false)}>Cancel</button>
            </>
          ) : (
            <>
              {!(v.state === 'gap' && v.required) && <button className="btn-primary" disabled={busy} onClick={() => onApprove(note)}>{v.state === 'gap' ? 'Confirm absent' : 'Approve'}</button>}
              <button disabled={busy} onClick={() => setEditing(true)}>{v.state === 'gap' ? 'Enter value' : 'Correct'}</button>
            </>
          )}
        </div>
      )}
      {v.decisions.length > 0 && (
        <details className="decisions" onClick={(e) => e.stopPropagation()}>
          <summary>{v.decisions.length} decision{v.decisions.length === 1 ? '' : 's'}</summary>
          <ul>
            {v.decisions.map((d) => (
              <li key={d.id}>
                {new Date(d.at).toLocaleString()} · {d.actor} · {d.action.replace('_', ' ')}
                {d.action === 'correct' && <> {d.oldValue ?? '∅'} → <strong>{d.newValue ?? '∅'}</strong></>}
                {d.note && <em> — {d.note}</em>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
};
