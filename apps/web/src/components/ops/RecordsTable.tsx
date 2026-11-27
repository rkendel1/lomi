import React, { useEffect, useState } from 'react';
import { call } from '../../lib/client';

interface Records {
  documentType: { key: string; name: string };
  columns: Array<{ key: string; label: string }>;
  rows: Array<{ documentId: string; title: string; version: number; templateVersion: number | null; processingStatus: string; submittedAt: string; values: Record<string, { value: string | null; state: string }> }>;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One form's normalized data for this customer: a row per document, a column
 * per element. Reviewed values where decided, else as extracted (marked).
 */
export const RecordsTable: React.FC<{ tenant: string; documentType: string }> = ({ tenant, documentType }) => {
  const [data, setData] = useState<Records | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    void call<Records>('records.list', { tenant, documentType }).then(setData).catch((e) => setError(e.message));
  }, [tenant, documentType]);

  const download = () => {
    if (!data) return;
    const header = ['document_id', 'title', 'version', ...data.columns.map((c) => c.key)];
    const lines = data.rows.map((r) => [r.documentId, r.title, r.version, ...data.columns.map((c) => r.values[c.key]?.value ?? '')].map(csvCell).join(','));
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${tenant}-${documentType}-records.csv`;
    a.click();
  };

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section className="card records">
      <div className="page-head">
        <div>
          <h2>{data.documentType.name} records</h2>
          <p className="small muted">One row per document (latest version), one column per element. Values not yet reviewed are shown in italics; missing ones as —.</p>
        </div>
        <button onClick={download} disabled={!data.rows.length}>Download CSV</button>
      </div>
      <div className="records-scroll">
        <table className="table">
          <thead>
            <tr><th>Document</th>{data.columns.map((c) => <th key={c.key} title={c.key}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.documentId} className="clickable" onClick={() => (window.location.hash = `/documents/${r.documentId}`)}>
                <td><a href={`#/documents/${r.documentId}`}>{r.title}</a> <span className="small muted">v{r.version}</span></td>
                {data.columns.map((c) => {
                  const cell = r.values[c.key];
                  return (
                    <td key={c.key} className={`cell-${cell?.state ?? 'none'}`} title={cell ? cell.state.replace('_', ' ') : 'not captured by this version'}>
                      {cell?.value ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={data.columns.length + 1} className="empty">No documents of this form yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
};
