import { useCallback, useEffect, useState } from 'react';
import { api, bytes } from '../api';
import Modal from '../components/Modal';

const TARGETS = [
  {
    id: 'images-dangling',
    title: 'Dangling images',
    blurb: 'Untagged leftovers from rebuilds. Nothing references these — the safest thing to clear.',
    danger: false,
    stat: (df) => ({ size: df.images.danglingSize, count: df.images.danglingCount }),
  },
  {
    id: 'build',
    title: 'Build cache',
    blurb: 'Cached layers from image builds. Removing them only makes the next build slower.',
    danger: false,
    stat: (df) => ({ size: df.buildCache.reclaimable, count: df.buildCache.unusedCount }),
  },
  {
    id: 'containers',
    title: 'Stopped containers',
    blurb: 'Removes every container that is not running. Their volumes are kept.',
    danger: true,
    stat: (df) => ({ size: df.containers.reclaimable, count: df.containers.stoppedCount }),
  },
  {
    id: 'images-unused',
    title: 'All unused images',
    blurb: 'Every image not used by a container, tagged or not. Anything still needed must be pulled or rebuilt again.',
    danger: true,
    stat: (df) => ({ size: df.images.reclaimable, count: df.images.unusedCount }),
  },
  {
    id: 'networks',
    title: 'Unused networks',
    blurb: 'Networks with no attached containers. Frees no disk space.',
    danger: false,
    stat: (df) => ({ size: 0, count: null }),
  },
];

function ConfirmPrune({ target, stat, onCancel, onConfirm, busy }) {
  return (
    <Modal
      title={`Prune ${target.title.toLowerCase()}?`}
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Pruning…' : 'Prune now'}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{target.blurb}</p>
      <p className="dim">
        This will free roughly <strong>{bytes(stat.size)}</strong>
        {stat.count !== null && <> across <strong>{stat.count}</strong> item{stat.count === 1 ? '' : 's'}</>}.
      </p>
      {target.danger && <div className="notice warn">This cannot be undone.</div>}
    </Modal>
  );
}

function RemoveVolume({ volume, onCancel, onDone }) {
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const nameMatches = typed === volume.name;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.elevate(password);
      await api.removeVolume(volume.name);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete this volume?"
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={submit} disabled={busy || !nameMatches || !password}>
            {busy ? 'Deleting…' : 'Delete volume'}
          </button>
        </>
      }
    >
      <div className="notice err">
        This permanently destroys the contents of <strong>{volume.name}</strong>
        {volume.size > 0 && <> ({bytes(volume.size)})</>}. There is no undo and no backup.
      </div>
      <p className="dim" style={{ marginTop: 0 }}>
        A volume shows as unused whenever its container simply isn't running — that does
        not mean the data is disposable.
        {volume.project && <> This one belongs to the <strong>{volume.project}</strong> compose project.</>}
      </p>

      {error && <div className="notice err">{error}</div>}

      <div className="field">
        <label>Type the volume name to confirm</label>
        <input type="text" value={typed} placeholder={volume.name} autoFocus
               onChange={(e) => setTyped(e.target.value)} />
      </div>
      <div className="field">
        <label>Your password</label>
        <input type="password" value={password} autoComplete="current-password"
               onChange={(e) => setPassword(e.target.value)} />
      </div>
    </Modal>
  );
}

export default function Maintenance() {
  const [df, setDf] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [volumeToRemove, setVolumeToRemove] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setDf(await api.systemDf());
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function runPrune(target) {
    setBusy(true);
    setError('');
    try {
      const r = await api.prune(target.id);
      setResult(`Freed ${bytes(r.spaceReclaimed)} by removing ${r.removed} ${r.label}.`);
      setConfirm(null);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!df) {
    return (
      <>
        <div className="page-head"><div><h1>Maintenance</h1></div></div>
        {error ? <div className="notice err">{error}</div> : <p className="dim">Reading disk usage…</p>}
      </>
    );
  }

  const totalReclaimable = df.images.reclaimable + df.containers.reclaimable + df.buildCache.reclaimable;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Maintenance</h1>
          <p>Reclaim Docker disk space. {bytes(totalReclaimable)} can be freed without touching volumes.</p>
        </div>
        <button className="btn" onClick={reload}>Refresh</button>
      </div>

      {error && <div className="notice err">{error}</div>}
      {result && <div className="notice ok">{result}</div>}

      <div className="grid cols-4">
        <div className="card">
          <h3>Images</h3>
          <div className="stat-value">{bytes(df.images.size)}</div>
          <div className="stat-sub">{bytes(df.images.reclaimable)} reclaimable · {df.images.total} total</div>
        </div>
        <div className="card">
          <h3>Build cache</h3>
          <div className="stat-value">{bytes(df.buildCache.size)}</div>
          <div className="stat-sub">{bytes(df.buildCache.reclaimable)} reclaimable</div>
        </div>
        <div className="card">
          <h3>Containers</h3>
          <div className="stat-value">{bytes(df.containers.size)}</div>
          <div className="stat-sub">{df.containers.stoppedCount} stopped</div>
        </div>
        <div className="card">
          <h3>Volumes</h3>
          <div className="stat-value">{bytes(df.volumes.size)}</div>
          <div className="stat-sub">{df.volumes.unused.length} not in use · {df.volumes.total} total</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Prune</h3>
        <div className="grid cols-2">
          {TARGETS.map((t) => {
            const stat = t.stat(df);
            const nothing = stat.count === 0;
            return (
              <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <strong>{t.title}</strong>
                  <span className="dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {stat.size > 0 ? bytes(stat.size) : stat.count === null ? '—' : `${stat.count} item${stat.count === 1 ? '' : 's'}`}
                  </span>
                </div>
                <p className="dim" style={{ fontSize: 12.5, margin: '7px 0 12px' }}>{t.blurb}</p>
                <button
                  className={`btn sm${t.danger ? ' danger' : ''}`}
                  disabled={busy || nothing}
                  onClick={() => setConfirm(t)}
                >
                  {nothing ? 'Nothing to prune' : 'Prune'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Unused volumes</h3>
        <div className="notice warn">
          There is no bulk volume prune here on purpose. A volume counts as unused whenever
          its container merely isn't running, so pruning them in bulk destroys live data.
          Delete them one at a time, once you're sure.
        </div>
        {df.volumes.unused.length ? (
          <div className="table-wrap" style={{ border: 0 }}>
            <table style={{ minWidth: 0 }}>
              <thead>
                <tr><th>Volume</th><th>Project</th><th>Size</th><th style={{ width: 1 }} /></tr>
              </thead>
              <tbody>
                {df.volumes.unused.map((v) => (
                  <tr key={v.name}>
                    <td className="mono" style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</td>
                    <td className="dim">{v.project || <span className="dim">—</span>}</td>
                    <td className="dim">{bytes(v.size)}</td>
                    <td>
                      <button className="btn sm danger" onClick={() => setVolumeToRemove(v)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim" style={{ margin: 0 }}>No unused volumes.</p>
        )}
      </div>

      {confirm && (
        <ConfirmPrune
          target={confirm}
          stat={confirm.stat(df)}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runPrune(confirm)}
        />
      )}
      {volumeToRemove && (
        <RemoveVolume
          volume={volumeToRemove}
          onCancel={() => setVolumeToRemove(null)}
          onDone={async () => {
            setResult(`Deleted volume ${volumeToRemove.name}.`);
            setVolumeToRemove(null);
            await reload();
          }}
        />
      )}
    </>
  );
}
