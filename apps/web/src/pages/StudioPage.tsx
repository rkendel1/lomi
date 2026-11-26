import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Field } from '@lomi/core';
import { Mapper } from '../components/studio/Mapper';
import { call, fetchPdf, fileToBase64 } from '../lib/client';

interface TemplateType {
  key: string;
  name: string;
  versions: Array<{ id: string; version: number; status: string; fieldCount: number; basePdfVersion: number | null; basePdfSha256: string | null; publishedAt: string | null }>;
}

interface Loaded {
  id: string;
  version: number;
  status: string;
  basePdf: { id: string; version: number; sha256: string } | null;
  definition: { fields: Field[]; crossFieldRules?: unknown[]; identityKeys?: string[]; rendering?: unknown };
  file: File | null;
}

/**
 * Schema Studio (Lomi operators): configure a customer's document types with
 * coordtool's mapper. Published template versions are immutable; saving after
 * a publish starts the next draft version.
 */
export const StudioPage: React.FC<{ tenant: string }> = ({ tenant }) => {
  const [types, setTypes] = useState<TemplateType[]>([]);
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [rulesText, setRulesText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newType, setNewType] = useState({ key: '', name: '' });
  const [pendingBase, setPendingBase] = useState<string | null>(null);
  const baseRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const r = await call<{ items: TemplateType[] }>('templates.list', { tenant });
    setTypes(r.items);
    return r.items;
  }, [tenant]);

  useEffect(() => {
    setLoaded(null);
    setTypeKey(null);
    void refresh().then((items) => setTypeKey(items[0]?.key ?? null)).catch((e) => setError(e.message));
  }, [refresh]);

  const open = useCallback(
    async (versionId: string) => {
      setError(null);
      setMessage(null);
      const t = await call('templates.get', { tenant, templateVersionId: versionId });
      const file = t.basePdf ? await fetchPdf(`/api/templates/basepdfs/${t.basePdf.id}/file`, tenant, `${t.documentType}-base.pdf`) : null;
      setLoaded({ ...t, file });
      setFields(t.definition.fields ?? []);
      setPendingBase(null);
      setRulesText(JSON.stringify({ crossFieldRules: t.definition.crossFieldRules ?? [], identityKeys: t.definition.identityKeys ?? [] }, null, 2));
    },
    [tenant]
  );

  const current = types.find((t) => t.key === typeKey) ?? null;
  useEffect(() => {
    if (current?.versions[0]) void open(current.versions[0].id).catch((e) => setError(e.message));
    else setLoaded(null);
  }, [current?.key, current?.versions[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rules = useMemo(() => {
    try {
      return { value: JSON.parse(rulesText || '{}'), error: null as string | null };
    } catch (e) {
      return { value: null, error: (e as Error).message };
    }
  }, [rulesText]);

  const saveDraft = async () => {
    if (!typeKey || !loaded || rules.error) return;
    try {
      const definition = { ...loaded.definition, fields, crossFieldRules: rules.value.crossFieldRules ?? [], identityKeys: rules.value.identityKeys ?? [] };
      const saved = await call('templates.drafts.save', { tenant, documentType: typeKey, definition, ...(pendingBase ? { basePdfId: pendingBase } : {}) });
      setMessage(`Saved draft version ${saved.version}.`);
      await refresh();
      await open(saved.id);
    } catch (e) {
      const details = (e as { details?: { problems?: string[] } }).details;
      setError(details?.problems?.join(' ') ?? (e as Error).message);
    }
  };

  const publish = async () => {
    if (!loaded) return;
    try {
      const p = await call('templates.publish', { tenant, templateVersionId: loaded.id });
      setMessage(`Published version ${p.version}. New documents of this type use it; earlier documents keep the version they were processed with.`);
      await refresh();
      await open(loaded.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const uploadBase = async (file: File) => {
    if (!typeKey) return;
    try {
      const b = await call('templates.basepdfs.upload', { tenant, documentType: typeKey, filename: file.name, contentBase64: await fileToBase64(file) });
      setPendingBase(b.id);
      setLoaded((l) => (l ? { ...l, file } : l));
      setMessage(b.existing ? `That PDF is already base PDF version ${b.version}.` : `Stored base PDF version ${b.version}. Save a draft to use it.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const editable = loaded?.status === 'draft';
  return (
    <div className="studio">
      <aside className="studio-side">
        <h2>Document types</h2>
        <ul className="list">
          {types.map((t) => (
            <li key={t.key} className={t.key === typeKey ? 'current' : ''}>
              <button className="btn-link" onClick={() => setTypeKey(t.key)}>{t.name}</button>
              <div className="small muted">{t.key} · {t.versions.length} version{t.versions.length === 1 ? '' : 's'}</div>
            </li>
          ))}
        </ul>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void call('templates.documenttypes.create', { tenant, ...newType })
              .then(async () => {
                setNewType({ key: '', name: '' });
                await refresh();
                setTypeKey(newType.key);
              })
              .catch((err) => setError(err.message));
          }}
        >
          <input aria-label="New type key" placeholder="key, e.g. purchase_order" value={newType.key} onChange={(e) => setNewType({ ...newType, key: e.target.value })} />
          <input aria-label="New type name" placeholder="Name" value={newType.name} onChange={(e) => setNewType({ ...newType, name: e.target.value })} />
          <button type="submit">Add document type</button>
        </form>

        {current && (
          <>
            <h2>Versions</h2>
            <ul className="list">
              {current.versions.map((v) => (
                <li key={v.id} className={v.id === loaded?.id ? 'current' : ''}>
                  <button className="btn-link" onClick={() => void open(v.id)}>v{v.version}</button> <span className={`state state-${v.status === 'published' ? 'approved' : 'pending'}`}>{v.status}</span>
                  <div className="small muted">{v.fieldCount} fields · base PDF v{v.basePdfVersion ?? '—'}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        {loaded && (
          <>
            <h2>Cross-field rules &amp; identity</h2>
            <textarea className="mono" rows={10} aria-label="Template rules" value={rulesText} onChange={(e) => setRulesText(e.target.value)} />
            {rules.error && <div className="error small">Invalid JSON: {rules.error}</div>}
          </>
        )}
      </aside>

      <section className="studio-main">
        {message && <div className="notice">{message}</div>}
        {error && <div className="error">{error}</div>}
        {!current ? (
          <div className="empty">Add a document type to start.</div>
        ) : !loaded ? (
          <div className="empty">
            <p>No template yet for {current.name}.</p>
            <input ref={baseRef} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && void uploadBase(e.target.files[0])} />
            <button className="btn-primary" onClick={() => baseRef.current?.click()}>Upload base PDF</button>
            {pendingBase && (
              <button onClick={() => void call('templates.drafts.save', { tenant, documentType: current.key, definition: { fields: [] }, basePdfId: pendingBase }).then(() => refresh())}>Create first draft</button>
            )}
          </div>
        ) : (
          <Mapper
            key={`${loaded.id}:${loaded.file?.name ?? ''}:${loaded.file?.size ?? 0}`}
            initialFile={loaded.file}
            initialFields={loaded.definition.fields}
            onFieldsChange={setFields}
            title={`${current.name} · template v${loaded.version}`}
            subtitle={editable ? 'Draft — edits are saved as this draft version' : 'Published — saving creates the next draft version'}
            headerExtra={
              <div className="studio-actions">
                <input ref={baseRef} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && void uploadBase(e.target.files[0])} />
                <button onClick={() => baseRef.current?.click()}>New base PDF</button>
                <button className="btn-primary" onClick={() => void saveDraft()} disabled={Boolean(rules.error)}>{editable ? 'Save draft' : 'Save as new draft'}</button>
                {editable && <button className="btn-primary" onClick={() => void publish()}>Publish</button>}
              </div>
            }
          />
        )}
      </section>
    </div>
  );
};
