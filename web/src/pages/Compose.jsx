import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, bytes } from '../api';
import StreamModal from '../components/StreamModal';

export default function Compose() {
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState(null);
  const [file, setFile] = useState(null);      // loaded file, as on disk
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(null);
  const [updating, setUpdating] = useState(null);
  const [history, setHistory] = useState([]);
  const taRef = useRef(null);

  const selectedPath = params.get('file') || '';

  useEffect(() => {
    api.composeProjects().then(setProjects).catch((e) => setStatus({ type: 'err', text: e.message }));
  }, []);

  const openFile = useCallback(async (p) => {
    setStatus(null);
    try {
      const f = await api.composeFile(p);
      setFile(f);
      setDraft(f.content);
      api.composeBackups(f.project).then(setHistory).catch(() => setHistory([]));
    } catch (err) {
      setStatus({ type: 'err', text: err.message });
      setFile(null);
    }
  }, []);

  // Pick the first file once projects land, unless the URL already names one.
  useEffect(() => {
    if (!projects?.length) return;
    const target = selectedPath || projects[0].files[0];
    if (target && target !== file?.path) openFile(target);
    if (!selectedPath && target) setParams({ file: target }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, selectedPath]);

  const dirty = file && draft !== file.content;

  async function save({ thenApply } = {}) {
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.saveComposeFile(file.path, draft, file.mtimeMs);
      if (res.unchanged) {
        setStatus({ type: 'ok', text: 'No changes to save.' });
      } else {
        setFile({ ...file, content: draft, mtimeMs: res.mtimeMs });
        setStatus({ type: 'ok', text: `Saved. Previous version backed up to ${res.backup.split('/').pop()}.` });
        api.composeBackups(file.project).then(setHistory).catch(() => {});
      }
      if (thenApply) setApplying(file.project);
    } catch (err) {
      // 422 means compose rejected it and the file was rolled back.
      const rolled = err.data?.rolledBack;
      setStatus({
        type: 'err',
        text: rolled
          ? `Not saved — compose rejected the file, so it was rolled back:\n\n${err.data.error}`
          : err.message,
      });
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (dirty && !busy) save();
    }
    // Tab should indent YAML rather than leave the textarea.
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.target;
      const { selectionStart: s, selectionEnd: en } = el;
      const next = `${draft.slice(0, s)}  ${draft.slice(en)}`;
      setDraft(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
  }

  if (!projects) {
    return (
      <>
        <div className="page-head"><div><h1>Compose</h1></div></div>
        {status ? <div className="notice err">{status.text}</div> : <p className="dim">Loading projects…</p>}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compose</h1>
          <p>
            {projects.length} project{projects.length === 1 ? '' : 's'}
            {file && <> · editing <span className="mono">{file.path}</span></>}
          </p>
        </div>
        <div className="btn-row">
          <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(file.content); setStatus(null); }}>
            Revert
          </button>
          <button className="btn" disabled={!dirty || busy} onClick={() => save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn primary" disabled={busy || !file} onClick={() => save({ thenApply: true })}>
            Save &amp; apply
          </button>
        </div>
      </div>

      {status && (
        <div className={`notice ${status.type}`} style={{ whiteSpace: 'pre-wrap' }}>{status.text}</div>
      )}
      {file && !file.writable && (
        <div className="notice warn">This file is not writable by kissd — you can view it but not save.</div>
      )}

      <div className="compose-layout">
        <aside className="compose-list">
          {projects.map((p) => (
            <div key={p.project} className="compose-project">
              <div className="compose-project-head">
                <strong>{p.project}</strong>
                <span className="dim">{p.running}/{p.containers}</span>
                <button
                  className="btn xs"
                  style={{ marginLeft: 'auto' }}
                  title={`Pull and recreate all ${p.services.length} services in ${p.project}`}
                  onClick={() => setUpdating(p.project)}
                >
                  Update
                </button>
              </div>
              <div className="dim mono compose-services">{p.services.join(', ')}</div>
              {p.files.map((f) => (
                <button
                  key={f}
                  className={`compose-file${f === file?.path ? ' active' : ''}`}
                  onClick={() => { setParams({ file: f }); openFile(f); }}
                >
                  {f.replace(`${p.workdir}/`, '')}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="compose-editor">
          {file ? (
            <>
              <textarea
                ref={taRef}
                className="mono"
                spellCheck="false"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                readOnly={!file.writable}
              />
              <div className="compose-foot dim">
                <span>{draft.split('\n').length} lines · {bytes(new Blob([draft]).size)}</span>
                <span>{dirty ? 'Unsaved changes · ⌘/Ctrl+S to save' : 'Saved'}</span>
              </div>
            </>
          ) : (
            <p className="dim">Select a file.</p>
          )}
        </div>
      </div>

      {history.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Backups · {file?.project}</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Every save keeps the previous version, in the kissd data volume rather than your repo.
          </p>
          <div className="table-wrap" style={{ border: 0 }}>
            <table style={{ minWidth: 0 }}>
              <tbody>
                {history.map((b) => (
                  <tr key={b.name}>
                    <td className="dim" style={{ width: 190 }}>{new Date(b.at).toLocaleString()}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{b.name}</td>
                    <td className="dim">{bytes(b.size)}</td>
                    <td style={{ width: 1 }}>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          const { content } = await api.composeBackup(file.project, b.name);
                          setDraft(content);
                          setStatus({ type: 'warn', text: 'Backup loaded into the editor. Nothing is written until you save.' });
                        }}
                      >
                        Load
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {applying && (
        <StreamModal
          title={`docker compose up -d · ${applying}`}
          url="/api/compose/apply"
          body={{ project: applying }}
          onClose={() => setApplying(null)}
        />
      )}

      {updating && (
        <StreamModal
          title={`docker compose pull && up -d · ${updating}`}
          url="/api/compose/update"
          body={{ project: updating }}
          onClose={() => setUpdating(null)}
        />
      )}
    </>
  );
}
