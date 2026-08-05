import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamPost } from '../api';
import XTerm from '../components/Terminal';
import Modal from '../components/Modal';

let seq = 0;

// Claude Code isn't bundled in the image — it installs on demand into the data
// volume, so it survives rebuilds without adding ~270MB to every pull.
function ClaudeInstaller({ status, onClose, onInstalled }) {
  const [log, setLog] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const preRef = useRef(null);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  async function go() {
    setRunning(true);
    setLog('');
    try {
      await streamPost('/api/claude/install', (chunk) => setLog((t) => t + chunk));
    } catch (err) {
      setLog((t) => `${t}\n${err.message}\n`);
    } finally {
      setRunning(false);
      setDone(true);
      onInstalled();
    }
  }

  return (
    <Modal
      title={status.installed ? 'Update Claude Code' : 'Install Claude Code'}
      onClose={running ? () => {} : onClose}
      flush={Boolean(log)}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={running}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button className="btn primary" onClick={go} disabled={running}>
              {running ? 'Installing…' : status.installed ? 'Update' : 'Install'}
            </button>
          )}
        </>
      }
    >
      {log ? (
        <pre className="stream" ref={preRef} style={{ maxHeight: '46vh' }}>{log}</pre>
      ) : (
        <div style={{ padding: 0 }}>
          <p style={{ marginTop: 0 }}>
            Claude Code is downloaded on demand rather than bundled into the image — it
            is around 270&nbsp;MB, which most people would rather not pull with every
            update.
          </p>
          <p className="dim">
            It installs into the <code className="mono">data/</code> volume, so it stays
            put across restarts, rebuilds and container recreation. Your sign-in persists
            there too.
          </p>
          {status.installed && status.version && (
            <p className="dim">Currently installed: <strong>{status.version}</strong></p>
          )}
        </div>
      )}
    </Modal>
  );
}

function ElevatePrompt({ onClose, onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.elevate(password);
      onSuccess();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Confirm your password" onClose={onClose}
           footer={
             <>
               <button className="btn" onClick={onClose}>Cancel</button>
               <button className="btn primary" onClick={submit} disabled={busy || !password}>
                 {busy ? 'Checking…' : 'Open host shell'}
               </button>
             </>
           }>
      <p style={{ marginTop: 0 }} className="dim">
        A host shell is root on this server. Re-enter your password to unlock it for 5 minutes.
      </p>
      <form onSubmit={submit}>
        {error && <div className="notice err">{error}</div>}
        <div className="field">
          <label htmlFor="elev">Password</label>
          <input id="elev" type="password" autoFocus autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </form>
    </Modal>
  );
}

export default function Terminals({ containers, pendingShell, clearPendingShell }) {
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [elevating, setElevating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [claude, setClaude] = useState(null);
  const [installerOpen, setInstallerOpen] = useState(false);

  const loadClaude = useCallback(async () => {
    try {
      setClaude(await api.claude());
    } catch {
      setClaude({ installed: false, installing: false, managed: true, version: null });
    }
  }, []);

  useEffect(() => { loadClaude(); }, [loadClaude]);

  function addSession(session) {
    const key = `t${seq++}`;
    setSessions((s) => [...s, { ...session, key }]);
    setActive(key);
  }

  function closeSession(key) {
    setSessions((s) => {
      const next = s.filter((x) => x.key !== key);
      setActive((a) => (a === key ? next[next.length - 1]?.key ?? null : a));
      return next;
    });
  }

  // A "Shell" click on the Containers page routes through here.
  useEffect(() => {
    if (!pendingShell) return;
    addSession({ label: pendingShell.name, params: { type: 'container', id: pendingShell.id } });
    clearPendingShell();
  }, [pendingShell, clearPendingShell]);

  const running = containers.filter((c) => c.state === 'running');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Terminal</h1>
          <p>Container shells, a host root shell, and Claude Code.</p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => setPickerOpen(true)}>Container shell</button>
          <button className="btn" onClick={() => setElevating(true)}>Host shell</button>
          {claude?.installed ? (
            <>
              <button className="btn primary" onClick={() => addSession({ label: 'Claude', params: { type: 'claude' } })}>
                Claude
              </button>
              {claude.managed && (
                <button className="btn sm" title={`Installed: ${claude.version || 'unknown'}`}
                        onClick={() => setInstallerOpen(true)}>
                  ⟳
                </button>
              )}
            </>
          ) : (
            <button className="btn" onClick={() => setInstallerOpen(true)} disabled={!claude}>
              {claude ? 'Install Claude Code' : 'Checking…'}
            </button>
          )}
        </div>
      </div>

      {claude && !claude.installed && (
        <div className="notice warn">
          Claude Code isn't installed yet. It is not bundled in the image — click
          <strong> Install Claude Code</strong> to fetch it into the data volume, where it
          survives rebuilds.
        </div>
      )}

      {sessions.length > 0 && (
        <div className="term-tabs">
          {sessions.map((s) => (
            <button
              key={s.key}
              className={`btn sm${s.key === active ? ' primary' : ''}`}
              onClick={() => setActive(s.key)}
            >
              {s.label}
              <span
                role="button"
                tabIndex={0}
                style={{ marginLeft: 8, opacity: .7 }}
                onClick={(e) => { e.stopPropagation(); closeSession(s.key); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeSession(s.key); } }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {sessions.length === 0 ? (
        <div className="card">
          <p className="dim" style={{ margin: 0 }}>
            No open sessions. Start one above — Claude runs inside this container with your
            login persisted, so you only sign in once.
          </p>
        </div>
      ) : (
        // Every session stays mounted so switching tabs doesn't kill the shell.
        sessions.map((s) => (
          <div key={s.key} style={{ display: s.key === active ? 'block' : 'none' }}>
            <XTerm params={s.params} />
          </div>
        ))
      )}

      {elevating && (
        <ElevatePrompt
          onClose={() => setElevating(false)}
          onSuccess={() => {
            setElevating(false);
            addSession({ label: 'host (root)', params: { type: 'host' } });
          }}
        />
      )}

      {installerOpen && claude && (
        <ClaudeInstaller
          status={claude}
          onClose={() => setInstallerOpen(false)}
          onInstalled={loadClaude}
        />
      )}

      {pickerOpen && (
        <Modal title="Open a shell in…" onClose={() => setPickerOpen(false)}
               footer={<button className="btn" onClick={() => setPickerOpen(false)}>Cancel</button>}>
          <div className="btn-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            {running.map((c) => (
              <button key={c.id} className="btn" style={{ textAlign: 'left' }}
                      onClick={() => {
                        addSession({ label: c.name, params: { type: 'container', id: c.id } });
                        setPickerOpen(false);
                      }}>
                {c.name} <span className="dim mono">· {c.image}</span>
              </button>
            ))}
            {!running.length && <p className="dim">No running containers.</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
