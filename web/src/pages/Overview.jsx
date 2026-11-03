import { useEffect, useState } from 'react';
import { api, bytes, duration } from '../api';
import HistoryPanel from '../components/HistoryPanel';

function severity(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return '';
}

function StatCard({ title, value, sub, pct }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
      {pct !== undefined && (
        <div className="bar"><i className={severity(pct)} style={{ width: `${Math.min(100, pct)}%` }} /></div>
      )}
    </div>
  );
}

export default function Overview({ containers }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const data = await api.host();
        if (stop) return;
        setSnap(data);
        setError('');
      } catch (err) {
        if (!stop) setError(err.message);
      }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const running = containers.filter((c) => c.state === 'running').length;
  const unhealthy = containers.filter((c) => c.health === 'unhealthy').length;
  const stopped = containers.length - running;

  if (error && !snap) return <div className="notice err">{error}</div>;
  if (!snap) return <p className="dim">Loading host metrics…</p>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>Uptime {duration(snap.uptime)} · {snap.cores} cores</p>
        </div>
      </div>

      <div className="grid cols-4">
        <StatCard
          title="CPU"
          value={`${snap.cpu.toFixed(1)}%`}
          sub={`Load ${snap.load.one.toFixed(2)} / ${snap.load.five.toFixed(2)} / ${snap.load.fifteen.toFixed(2)}`}
          pct={snap.cpu}
        />
        <StatCard
          title="Memory"
          value={`${snap.memory.percent.toFixed(1)}%`}
          sub={`${bytes(snap.memory.used)} of ${bytes(snap.memory.total)} used`}
          pct={snap.memory.percent}
        />
        <StatCard
          title="Containers"
          value={`${running}/${containers.length}`}
          sub={
            unhealthy ? `${unhealthy} unhealthy · ${stopped} stopped`
              : stopped ? `${stopped} stopped` : 'All running'
          }
        />
        <StatCard
          title="Network"
          value={`${bytes(snap.network.rxRate)}/s`}
          sub={`▲ ${bytes(snap.network.txRate)}/s · total ▼ ${bytes(snap.network.rxBytes)}`}
        />
      </div>

      {snap.cpuPerCore?.length > 0 && (
        <div className="card cpu-cores">
          <h3>CPU usage per core</h3>
          <p className="dim metrics-caption">Logical CPUs · live usage · updates every 3 seconds</p>
          <div className="cpu-core-grid">
            {snap.cpuPerCore.map(({ id, percent }) => (
              <div key={id}>
                <div className="cpu-core-label">
                  <span>CPU {id}</span>
                  <span className="dim">{percent == null ? '—' : `${percent.toFixed(1)}%`}</span>
                </div>
                <div className="bar" role="progressbar" aria-label={`CPU ${id} usage`}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
                  aria-valuetext={percent == null ? 'Waiting for CPU sample' : `${percent.toFixed(1)}%`}>
                  <i className={severity(percent)} style={{ width: `${percent ?? 0}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <HistoryPanel compact />

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Disks</h3>
        {snap.disks.map((d) => (
          <div key={d.mountPoint} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span className="mono">{d.mountPoint}</span>
              <span className="dim">{bytes(d.used)} / {bytes(d.total)} · {d.percent.toFixed(0)}%</span>
            </div>
            <div className="bar"><i className={severity(d.percent)} style={{ width: `${d.percent}%` }} /></div>
          </div>
        ))}
        {!snap.disks.length && <p className="dim">No filesystems detected.</p>}
      </div>

      {snap.memory.swapTotal > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Swap</h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span className="dim">{bytes(snap.memory.swapUsed)} of {bytes(snap.memory.swapTotal)}</span>
            <span className="dim">{snap.memory.swapPercent.toFixed(0)}%</span>
          </div>
          <div className="bar"><i className={severity(snap.memory.swapPercent)} style={{ width: `${snap.memory.swapPercent}%` }} /></div>
        </div>
      )}
    </>
  );
}
