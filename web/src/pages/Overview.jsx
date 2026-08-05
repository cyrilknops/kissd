import { useEffect, useRef, useState } from 'react';
import { api, bytes, duration } from '../api';
import Sparkline from '../components/Sparkline';

const HISTORY = 40;

function severity(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return '';
}

function StatCard({ title, value, sub, pct, spark, color }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
      {spark && <div style={{ marginTop: 10 }}><Sparkline data={spark} max={100} color={color} /></div>}
      {pct !== undefined && (
        <div className="bar"><i className={severity(pct)} style={{ width: `${Math.min(100, pct)}%` }} /></div>
      )}
    </div>
  );
}

export default function Overview({ containers }) {
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState('');
  const cpuHist = useRef([]);
  const memHist = useRef([]);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const data = await api.host();
        if (stop) return;
        cpuHist.current = [...cpuHist.current, data.cpu].slice(-HISTORY);
        memHist.current = [...memHist.current, data.memory.percent].slice(-HISTORY);
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
          spark={cpuHist.current}
          color="#4f8cff"
        />
        <StatCard
          title="Memory"
          value={`${snap.memory.percent.toFixed(1)}%`}
          sub={`${bytes(snap.memory.used)} of ${bytes(snap.memory.total)} used`}
          pct={snap.memory.percent}
          spark={memHist.current}
          color="#2ecc71"
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
