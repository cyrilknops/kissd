import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, streamUpdate, bytes, ago, duration } from '../api';
import LogStream from '../components/LogStream';

function Row({ label, children, mono }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="kv">
      <div className="kv-k">{label}</div>
      <div className={`kv-v${mono ? ' mono' : ''}`}>{children}</div>
    </div>
  );
}

export default function ContainerDetail({ onOpenShell }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [updateLog, setUpdateLog] = useState(null);
  const updateRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setC(await api.container(id));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (updateRef.current) updateRef.current.scrollTop = updateRef.current.scrollHeight;
  }, [updateLog]);

  async function act(action) {
    setBusy(action);
    setError('');
    try {
      await api.containerAction(c.id, action);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function runUpdate() {
    setBusy('update');
    setUpdateLog('');
    try {
      await streamUpdate(c.id, (chunk) => setUpdateLog((t) => (t || '') + chunk));
    } catch (err) {
      setUpdateLog((t) => `${t || ''}\n${err.message}\n`);
    } finally {
      setBusy(null);
      load();
    }
  }

  if (error && !c) {
    return (
      <>
        <div className="page-head"><div><h1>Container</h1></div></div>
        <div className="notice err">{error}</div>
        <Link className="btn" to="/containers">← Back to containers</Link>
      </>
    );
  }
  if (!c) return <p className="dim">Loading…</p>;

  const memPct = c.stats?.memoryLimit ? (c.stats.memory / c.stats.memoryLimit) * 100 : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/containers" className="dim" style={{ fontSize: 13, textDecoration: 'none' }}>← Containers</Link>
          <h1 style={{ marginTop: 4 }}>
            {c.name}{' '}
            <span className={`pill ${c.state}`} style={{ verticalAlign: 'middle', fontSize: 12 }}>
              <span className="dot" />{c.state}
            </span>
            {c.health && (
              <span className={`pill ${c.health}`} style={{ verticalAlign: 'middle', fontSize: 12, marginLeft: 6 }}>
                {c.health}
              </span>
            )}
          </h1>
          <p className="mono">{c.image}</p>
        </div>
        <div className="btn-row">
          {c.running ? (
            <>
              <button className="btn sm" disabled={busy} onClick={() => act('restart')}>
                {busy === 'restart' ? '…' : 'Restart'}
              </button>
              <button className="btn sm danger" disabled={busy} onClick={() => act('stop')}>
                {busy === 'stop' ? '…' : 'Stop'}
              </button>
            </>
          ) : (
            <button className="btn sm" disabled={busy} onClick={() => act('start')}>
              {busy === 'start' ? '…' : 'Start'}
            </button>
          )}
          <button className="btn sm" disabled={!c.running}
                  onClick={() => { onOpenShell({ id: c.id, name: c.name }); navigate('/terminal'); }}>
            Shell
          </button>
          <button className="btn sm primary" disabled={busy || !c.compose}
                  title={c.compose ? 'docker compose pull && up -d' : 'Not compose-managed'}
                  onClick={runUpdate}>
            {busy === 'update' ? 'Updating…' : 'Update'}
          </button>
        </div>
      </div>

      {error && <div className="notice err">{error}</div>}
      {c.isSelf && (
        <div className="notice warn">
          This is kissd itself. Updating it hands the compose run to the host and
          detaches, so the panel will briefly drop out — reload once it returns.
        </div>
      )}

      <div className="grid cols-4">
        <div className="card">
          <h3>CPU</h3>
          <div className="stat-value">{c.stats?.cpu != null ? `${c.stats.cpu.toFixed(1)}%` : '—'}</div>
        </div>
        <div className="card">
          <h3>Memory</h3>
          <div className="stat-value">{c.stats ? bytes(c.stats.memory) : '—'}</div>
          {c.stats?.memoryLimit > 0 && (
            <>
              <div className="stat-sub">{memPct.toFixed(1)}% of {bytes(c.stats.memoryLimit)}</div>
              <div className="bar"><i className={memPct >= 90 ? 'crit' : memPct >= 75 ? 'warn' : ''} style={{ width: `${Math.min(100, memPct)}%` }} /></div>
            </>
          )}
        </div>
        <div className="card">
          <h3>Uptime</h3>
          <div className="stat-value">
            {c.running && c.startedAt ? duration((Date.now() - new Date(c.startedAt)) / 1000) : '—'}
          </div>
          <div className="stat-sub">Created {ago(new Date(c.created).getTime())} ago</div>
        </div>
        <div className="card">
          <h3>Restarts</h3>
          <div className="stat-value">{c.restartCount}</div>
          <div className="stat-sub">Policy: {c.restartPolicy}</div>
        </div>
      </div>

      {updateLog !== null && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Update output</h3>
          <pre className="stream" ref={updateRef} style={{ maxHeight: '32vh' }}>{updateLog || 'Starting…'}</pre>
        </div>
      )}

      {c.health === 'unhealthy' && c.healthLog.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Failing healthcheck</h3>
          {c.healthLog.map((l, i) => (
            <pre key={i} className="stream" style={{ maxHeight: 140, marginBottom: 8 }}>
              exit {l.exitCode} · {new Date(l.start).toLocaleString()}
              {'\n'}{l.output || '(no output)'}
            </pre>
          ))}
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Details</h3>
          <Row label="Container ID" mono>{c.id.slice(0, 12)}</Row>
          <Row label="Image ID" mono>{(c.imageId || '').replace('sha256:', '').slice(0, 12)}</Row>
          <Row label="Command" mono>{c.command}</Row>
          <Row label="Created">{new Date(c.created).toLocaleString()}</Row>
          {!c.running && c.finishedAt && Number(new Date(c.finishedAt)) > 0 && (
            <Row label="Exited">{new Date(c.finishedAt).toLocaleString()} (code {c.exitCode})</Row>
          )}
          {c.compose && (
            <>
              <Row label="Compose project">{c.compose.project}</Row>
              <Row label="Service">{c.compose.service}</Row>
              <Row label="Working dir" mono>{c.compose.workdir}</Row>
            </>
          )}
        </div>

        <div className="card">
          <h3>Networking</h3>
          {c.networks.map((n) => (
            <Row key={n.name} label={n.name} mono>{n.ip || '—'}</Row>
          ))}
          {c.ports.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="kv-k" style={{ marginBottom: 6 }}>Ports</div>
              {c.ports.map((p, i) => (
                <div key={i} className="mono" style={{ fontSize: 12 }}>
                  {p.published ? `${p.published} → ${p.internal}` : `${p.internal} (not published)`}
                </div>
              ))}
            </div>
          ) : (
            <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>No published ports.</p>
          )}
        </div>
      </div>

      {c.mounts.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Mounts</h3>
          <div className="table-wrap" style={{ border: 0 }}>
            <table style={{ minWidth: 0 }}>
              <thead>
                <tr><th>Type</th><th>Source</th><th>Destination</th><th>Mode</th></tr>
              </thead>
              <tbody>
                {c.mounts.map((m, i) => (
                  <tr key={i}>
                    <td className="dim">{m.type}</td>
                    <td className="mono" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {m.name || m.source}
                    </td>
                    <td className="mono">{m.destination}</td>
                    <td className="dim">{m.rw ? 'rw' : 'ro'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Logs</h3>
        <LogStream containerId={c.id} style={{ maxHeight: '40vh' }} />
      </div>
    </>
  );
}
