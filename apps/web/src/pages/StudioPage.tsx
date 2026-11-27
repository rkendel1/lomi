import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Field } from '@lomi/core';
import { Mapper } from '../components/studio/Mapper';
import { QuickForm } from '../components/studio/QuickForm';
import { call, fetchPdf, fileToBase64 } from '../lib/client';

interface Version {
  id: string;
  version: number;
  status: string;
  fieldCount: number;
  basePdfVersion: number | null;
  basePdfSha256: string | null;
  publishedAt: string | null;
}
interface TemplateType {
  key: string;
  name: string;
  versions: Version[];
}
type CrossFieldRule =
  | { id: string; kind: 'sum'; terms: string[]; equals: string; tolerance?: number; message?: string }
  | { id: string; kind: 'date_order'; earlier: string; later: string; message?: string };
interface Definition {
  fields: Field[];
  crossFieldRules?: CrossFieldRule[];
  identityKeys?: string[];
  rendering?: unknown;
}
interface Loaded {
  id: string;
  version: number;
  status: string;
  basePdf: { id: string; version: number; sha256: string } | null;
  definition: Definition;
  file: File | null;
}

const stable = (v: unknown) => JSON.stringify(v);

/**
 * Schema Studio (Lomi operators): configure a customer's document types.
 * Fields are mapped on the base PDF with coordtool's mapper; extraction,
 * validation and review settings live on each field; cross-field rules and
 * duplicate-detection keys live on the template. Published versions are
 * immutable — saving after a publish starts the next draft.
 */
export const StudioPage: React.FC<{ tenant: string }> = ({ tenant }) => {
  const [types, setTypes] = useState<TemplateType[]>([]);
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [rules, setRules] = useState<CrossFieldRule[]>([]);
  const [identityKeys, setIdentityKeys] = useState<string[]>([]);
  const [tab, setTab] = useState<'fields' | 'rules' | 'versions'>('fields');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState(false);
  const [quickForm, setQuickForm] = useState(false);
  const [newType, setNewType] = useState({ key: '', name: '' });
  const [pendingBase, setPendingBase] = useState<{ id: string; version: number } | null>(null);
  const baseRef = useRef<HTMLInputElement>(null);
  /** A message to show once the newly selected type has opened (switching types clears messages). */
  const pendingMessage = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await call<{ items: TemplateType[] }>('templates.list', { tenant });
    setTypes(r.items);
    return r.items;
  }, [tenant]);

  const open = useCallback(
    async (versionId: string) => {
      setError(null);
      const t = await call('templates.get', { tenant, templateVersionId: versionId });
      const file = t.basePdf ? await fetchPdf(`/api/templates/basepdfs/${t.basePdf.id}/file`, tenant, `${t.documentType}-base.pdf`) : null;
      setLoaded({ ...t, file });
      setFields(t.definition.fields ?? []);
      setRules(t.definition.crossFieldRules ?? []);
      setIdentityKeys(t.definition.identityKeys ?? []);
      setPendingBase(null);
    },
    [tenant]
  );

  useEffect(() => {
    void refresh()
      .then((items) => {
        setTypeKey((k) => k ?? items[0]?.key ?? null);
        // A customer with no forms yet: start with the quick setup.
        if (items.length === 0) setQuickForm(true);
      })
      .catch((e) => setError(e.message));
  }, [refresh]);

  const current = types.find((t) => t.key === typeKey) ?? null;
  useEffect(() => {
    setLoaded(null);
    setMessage(pendingMessage.current);
    pendingMessage.current = null;
    if (current?.versions[0]) void open(current.versions[0].id).catch((e) => setError(e.message));
  }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!loaded) return false;
    const d = loaded.definition;
    return stable(fields) !== stable(d.fields ?? []) || stable(rules) !== stable(d.crossFieldRules ?? []) || stable(identityKeys) !== stable(d.identityKeys ?? []) || Boolean(pendingBase);
  }, [loaded, fields, rules, identityKeys, pendingBase]);

  const save = async () => {
    if (!typeKey || !loaded) return;
    try {
      const definition = { ...loaded.definition, fields, crossFieldRules: rules, identityKeys };
      const saved = await call('templates.drafts.save', { tenant, documentType: typeKey, definition, ...(pendingBase ? { basePdfId: pendingBase.id } : {}) });
      setMessage(`Saved draft v${saved.version}.`);
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
      setMessage(`Published v${p.version}. New documents of this type use it; earlier documents keep the version they were processed with.`);
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
      if (!loaded) {
        const draft = await call('templates.drafts.save', { tenant, documentType: typeKey, definition: { fields: [] }, basePdfId: b.id });
        await refresh();
        await open(draft.id);
        setMessage(`Created draft v${draft.version} on base PDF v${b.version}. Draw fields on it to start.`);
      } else {
        setPendingBase({ id: b.id, version: b.version });
        setLoaded((l) => (l ? { ...l, file } : l));
        setMessage(b.existing ? `That PDF is already base PDF v${b.version}.` : `Stored base PDF v${b.version}. Save to use it in a draft.`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createType = async () => {
    try {
      await call('templates.documenttypes.create', { tenant, ...newType });
      await refresh();
      setTypeKey(newType.key);
      setCreatingType(false);
      setNewType({ key: '', name: '' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const editable = loaded?.status === 'draft';
  const keys = fields.map((f) => f.semanticKey).filter(Boolean);

  return (
    <div className="studio2">
      <div className="studio-bar">
        <div className="studio-crumbs">
          <span className="crumb-root">Schema Studio</span>
          <span className="crumb-sep">›</span>
          <select aria-label="Document type" value={typeKey ?? ''} onChange={(e) => (e.target.value === '+' ? setQuickForm(true) : setTypeKey(e.target.value))}>
            {types.length === 0 && <option value="">No forms yet</option>}
            {types.map((t) => (
              <option key={t.key} value={t.key}>{t.name}</option>
            ))}
            <option value="+">+ New form…</option>
          </select>
          {current && current.versions.length > 0 && (
            <>
              <span className="crumb-sep">›</span>
              <select aria-label="Template version" value={loaded?.id ?? ''} onChange={(e) => void open(e.target.value)}>
                {current.versions.map((v) => (
                  <option key={v.id} value={v.id}>v{v.version} · {v.status}</option>
                ))}
              </select>
            </>
          )}
          {loaded && <span className={`pill pill-${loaded.status}`}>{loaded.status === 'draft' ? 'Draft — editable' : `${loaded.status} — read-only`}</span>}
          {dirty && <span className="pill pill-dirty">Unsaved changes</span>}
        </div>
        <div className="studio-actions">
          <button onClick={() => { setQuickForm(true); setCreatingType(false); }}>+ New form</button>
          <input ref={baseRef} type="file" accept="application/pdf" hidden aria-label="Base PDF" onChange={(e) => { if (e.target.files?.[0]) void uploadBase(e.target.files[0]); e.target.value = ''; }} />
          {current && <button onClick={() => baseRef.current?.click()}>{loaded ? 'Replace base PDF' : 'Upload base PDF'}</button>}
          {loaded && (
            <button className="btn-primary" disabled={!dirty && editable} onClick={() => void save()}>
              {editable ? 'Save draft' : 'Save as new draft'}
            </button>
          )}
          {loaded && editable && <button className="btn-primary" disabled={dirty} title={dirty ? 'Save first' : ''} onClick={() => void publish()}>Publish v{loaded.version}</button>}
        </div>
      </div>

      {quickForm && (
        <div className="page">
          <QuickForm
            tenant={tenant}
            onCancel={() => setQuickForm(false)}
            onBlank={() => { setQuickForm(false); setCreatingType(true); }}
            onCreated={(key, msg) => {
              setQuickForm(false);
              setError(null);
              pendingMessage.current = msg;
              void refresh().then(() => setTypeKey(key));
            }}
          />
        </div>
      )}
      {creatingType && (
        <form className="studio-newtype" onSubmit={(e) => { e.preventDefault(); void createType(); }}>
          <strong>New document type</strong>
          <input aria-label="New type name" placeholder="Name, e.g. Purchase order" value={newType.name} onChange={(e) => setNewType({ name: e.target.value, key: newType.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })} />
          <input aria-label="New type key" placeholder="key" value={newType.key} onChange={(e) => setNewType({ ...newType, key: e.target.value })} />
          <button className="btn-primary" type="submit" disabled={!newType.key || !newType.name}>Create</button>
          <button type="button" className="btn-link" onClick={() => setCreatingType(false)}>Cancel</button>
        </form>
      )}
      {message && <div className="notice studio-msg">{message}</div>}
      {error && <div className="error studio-msg">{error}</div>}

      {quickForm ? null : !current ? (
        <div className="empty studio-empty">
          <h2>No forms yet for this customer</h2>
          <p className="muted">A form says what kind of document this customer sends and what to read from it.</p>
          <button className="btn-primary" onClick={() => setQuickForm(true)}>+ New form</button>
        </div>
      ) : !loaded ? (
        <div className="empty studio-empty">
          <h2>{current.name} has no template yet</h2>
          <p className="muted">Upload the PDF that outputs will be rendered onto. You will then map its fields and say how each is read from incoming documents.</p>
          <button className="btn-primary" onClick={() => baseRef.current?.click()}>Upload base PDF</button>
        </div>
      ) : (
        <>
          <div className="tabs studio-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'fields'} className={tab === 'fields' ? 'active' : ''} onClick={() => setTab('fields')}>Fields &amp; layout ({fields.length})</button>
            <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>Rules ({rules.length})</button>
            <button role="tab" aria-selected={tab === 'versions'} className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>Versions ({current.versions.length})</button>
          </div>

          {tab === 'fields' && (
            <div className="studio-canvas">
              <Mapper
                key={`${loaded.id}:${pendingBase?.id ?? ''}`}
                embedded
                initialFile={loaded.file}
                initialFields={fields}
                onFieldsChange={setFields}
              />
            </div>
          )}

          {tab === 'rules' && (
            <RulesEditor keys={keys} rules={rules} onRules={setRules} identityKeys={identityKeys} onIdentityKeys={setIdentityKeys} />
          )}

          {tab === 'versions' && (
            <div className="page">
              <table className="table">
                <thead>
                  <tr><th>Version</th><th>Status</th><th>Fields</th><th>Base PDF</th><th>Published</th><th /></tr>
                </thead>
                <tbody>
                  {current.versions.map((v) => (
                    <tr key={v.id} className={v.id === loaded.id ? 'current-row' : ''}>
                      <td>v{v.version}</td>
                      <td><span className={`pill pill-${v.status}`}>{v.status}</span></td>
                      <td>{v.fieldCount}</td>
                      <td>v{v.basePdfVersion ?? '—'} {v.basePdfSha256 && <span className="mono small muted">{v.basePdfSha256.slice(0, 10)}…</span>}</td>
                      <td>{v.publishedAt ? new Date(v.publishedAt).toLocaleString() : '—'}</td>
                      <td>{v.id !== loaded.id && <button onClick={() => { void open(v.id); setTab('fields'); }}>Open</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">Documents record the template version they were processed with. Publishing a new version never changes earlier documents or their outputs.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const RulesEditor: React.FC<{
  keys: string[];
  rules: CrossFieldRule[];
  onRules: (r: CrossFieldRule[]) => void;
  identityKeys: string[];
  onIdentityKeys: (k: string[]) => void;
}> = ({ keys, rules, onRules, identityKeys, onIdentityKeys }) => {
  const [kind, setKind] = useState<'sum' | 'date_order'>('sum');
  const [terms, setTerms] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [earlier, setEarlier] = useState('');
  const [later, setLater] = useState('');

  const add = () => {
    const id = `rule_${rules.length + 1}`;
    if (kind === 'sum' && terms.length && target) onRules([...rules, { id, kind: 'sum', terms, equals: target }]);
    if (kind === 'date_order' && earlier && later) onRules([...rules, { id, kind: 'date_order', earlier, later }]);
    setTerms([]);
    setTarget('');
  };

  return (
    <div className="page rules">
      <section className="card">
        <h2>Cross-field checks</h2>
        <p className="small muted">Deterministic checks across fields. A failure flags every field involved for review.</p>
        <ul className="list">
          {rules.length === 0 && <li className="muted">No cross-field checks.</li>}
          {rules.map((r, i) => (
            <li key={r.id} className="rule-row">
              <span>
                {r.kind === 'sum' ? <><code>{r.terms.join(' + ')}</code> must equal <code>{r.equals}</code></> : <><code>{r.earlier}</code> must be on or before <code>{r.later}</code></>}
              </span>
              <button className="btn-link" onClick={() => onRules(rules.filter((_, j) => j !== i))}>Remove</button>
            </li>
          ))}
        </ul>
        <div className="form-row rule-add">
          <label>Check
            <select aria-label="Check kind" value={kind} onChange={(e) => setKind(e.target.value as 'sum' | 'date_order')}>
              <option value="sum">Amounts add up</option>
              <option value="date_order">Date order</option>
            </select>
          </label>
          {kind === 'sum' ? (
            <>
              <label>These fields
                <select aria-label="Sum terms" multiple size={Math.min(5, keys.length)} value={terms} onChange={(e) => setTerms(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                  {keys.map((k) => <option key={k}>{k}</option>)}
                </select>
              </label>
              <label>must add up to
                <select aria-label="Sum target" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">—</option>
                  {keys.map((k) => <option key={k}>{k}</option>)}
                </select>
              </label>
            </>
          ) : (
            <>
              <label>Earlier
                <select aria-label="Earlier date" value={earlier} onChange={(e) => setEarlier(e.target.value)}><option value="">—</option>{keys.map((k) => <option key={k}>{k}</option>)}</select>
              </label>
              <label>Later
                <select aria-label="Later date" value={later} onChange={(e) => setLater(e.target.value)}><option value="">—</option>{keys.map((k) => <option key={k}>{k}</option>)}</select>
              </label>
            </>
          )}
          <button onClick={add}>Add check</button>
        </div>
      </section>
      <section className="card">
        <h2>Duplicate detection</h2>
        <p className="small muted">Documents with the same values in these fields are flagged as possibly the same transaction (never merged automatically).</p>
        <div className="check-grid">
          {keys.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={identityKeys.includes(k)} onChange={(e) => onIdentityKeys(e.target.checked ? [...identityKeys, k] : identityKeys.filter((x) => x !== k))} />
              <code>{k}</code>
            </label>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Field-level settings</h2>
        <p className="small muted">How each field is extracted, which checks run on it (including typed model checks), and when a person must review it are set per field: select a field on the <strong>Fields &amp; layout</strong> tab.</p>
      </section>
    </div>
  );
};
