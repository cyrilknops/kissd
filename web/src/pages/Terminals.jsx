import { useEffect, useState } from 'react';
import { api } from '../api';
import XTerm from '../components/Terminal';
import Modal from '../components/Modal';

let seq = 0;

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
          <button className="btn primary" onClick={() => addSession({ label: 'Claude', params: { type: 'claude' } })}>
            Claude
          </button>
        </div>
      </div>

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
