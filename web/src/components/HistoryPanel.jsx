import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, bytes } from '../api';

const COLORS = { up: '#2ecc71', down: '#ef4757', unhealthy: '#f5a623', unknown: '#555e73' };
const LABELS = { up: 'Running / healthy', down: 'Stopped / down', unhealthy: 'Unhealthy', unknown: 'Unknown / no observation' };
const pct = (n) => Number.isFinite(n) ? `${n.toFixed(1)}%` : '—';
const number = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
const count = (n) => Number.isFinite(n) ? n.toFixed(Number.isInteger(n) ? 0 : 1) : '—';
const speed = (n) => Number.isFinite(n) ? `${bytes(n)}/s` : '—';
const stamp = (at) => new Date(at).toLocaleString();
function elapsed(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor(secs % 3600 / 60)}m`;
}
function tick(at, range) {
  return new Date(at).toLocaleString(undefined, range.endsWith('h')
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Chart({ title, series, format, history, hover, onHover, floor = 0, children }) {
  const svgRef = useRef(null);
  const [width, setWidth] = useState(500);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(svgRef.current);
    return () => observer.disconnect();
  }, []);
  const { points, from, to, intervalMs, availability } = history;
  const W = Math.max(280, width), H = 180, L = 65, R = 12, T = 12, B = 25;
  const x = (at) => L + (at - from) / (to - from) * (W - L - R);
  // Avoid spreading cores × samples into function arguments on large hosts.
  const ceiling = points.reduce((max, p) => series.reduce((value, s) => Math.max(value, p[`${s.key}Peak`] ?? p[s.key] ?? 0), max), Math.max(floor, 1));
  const y = (value) => H - B - value / ceiling * (H - B - T);
  const selected = hover === null || !points.length ? null : points.reduce((best, p) => Math.abs(p.at - hover) < Math.abs(best.at - hover) ? p : best, points[0]);
  function line(key) {
    let previous = null;
    return points.map((p) => {
      if (!Number.isFinite(p[key])) { previous = null; return ''; }
      const gap = previous && (p.at - previous.at > intervalMs * 1.5 || availability.some((a) => a.state !== 'up' && a.state !== 'unhealthy' && a.from < p.at && a.to > previous.at));
      const command = !previous || gap ? 'M' : 'L';
      previous = p;
      return `${command}${x(p.at)},${y(p[key])}`;
    }).join(' ');
  }
  return (
    <div className="card metric-chart">
      <h3>{title}</h3>
      {children}
      <div className="chart-readout">
        <span className="dim">{selected ? stamp(selected.at) : 'Hover or focus the chart to inspect'}</span>
        {series.map((s) => <span key={s.key} style={{ color: s.color }}>{s.label}{selected ? '' : ' avg'}: {format(selected ? selected[s.key] : history.summary[`${s.key}Avg`])}{selected && ` · peak ${format(selected[`${s.key}Peak`])}`}</span>)}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0}
        aria-label={`${title} history. Use left and right arrow keys to inspect samples.`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onHover(from + Math.max(0, Math.min(1, ((e.clientX - rect.left) / rect.width * W - L) / (W - L - R))) * (to - from));
        }}
        onPointerLeave={() => onHover(null)} onBlur={() => onHover(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const idx = selected ? points.indexOf(selected) : points.length - 1;
          onHover(points[Math.max(0, Math.min(points.length - 1, idx + (e.key === 'ArrowLeft' ? -1 : 1)))]?.at ?? null);
        }}>
        {[0, 0.5, 1].map((fraction) => <g key={fraction}>
          <line x1={L} x2={W - R} y1={y(ceiling * fraction)} y2={y(ceiling * fraction)} stroke="var(--border)" />
          <text x={L - 8} y={y(ceiling * fraction) + 4} textAnchor="end">{format(ceiling * fraction)}</text>
        </g>)}
        {availability.filter((a) => a.state !== 'up').map((a) => <rect key={a.from} x={x(a.from)} y={T} width={Math.max(0, x(a.to) - x(a.from))} height={H - B - T} fill={COLORS[a.state]} opacity={a.state === 'unknown' ? 0.06 : 0.14}>
          <title>{LABELS[a.state]} · {stamp(a.from)} – {stamp(a.to)}</title>
        </rect>)}
        {series.map((s) => <g key={s.key} data-series={s.key}>
          <title>{s.label}</title>
          <path d={line(`${s.key}Peak`)} fill="none" stroke={s.color} strokeOpacity="0.35" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={line(s.key)} fill="none" stroke={s.color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
          {points.length === 1 && Number.isFinite(points[0][s.key]) && <circle cx={x(points[0].at)} cy={y(points[0][s.key])} r="3" fill={s.color} />}
        </g>)}
        {selected && <g>
          <line x1={x(selected.at)} x2={x(selected.at)} y1={T} y2={H - B} stroke="var(--muted)" strokeDasharray="3 3" />
          {series.filter((s) => Number.isFinite(selected[s.key])).map((s) => <circle key={s.key} cx={x(selected.at)} cy={y(selected[s.key])} r="3.5" fill={s.color} />)}
        </g>}
        {(W < 500 ? [0, 1] : [0, 0.5, 1]).map((fraction) => <text key={fraction} x={x(from + (to - from) * fraction)} y={H - 3} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{tick(from + (to - from) * fraction, history.range)}</text>)}
      </svg>
      <div className="hint">Solid: average · faint: peak per {elapsed(intervalMs)} bucket</div>
    </div>
  );
}

function CpuChart({ history, host, hover, onHover, chosen, onChoose }) {
  const cores = history.cpuCores || [];
  const selected = chosen === null ? cores : chosen;
  const series = [
    { key: 'cpu', label: host ? 'Host' : 'Container total', color: '#4f8cff' },
    ...cores.filter((id) => selected.includes(id)).map((id) => ({
      key: `cpuCore${id}`, label: `CPU ${id}`, color: `hsl(${(id * 137.508 + 22) % 360} 75% 65%)`,
    })),
  ];
  return <Chart title="CPU utilization" {...{ series, history, hover, onHover }} format={pct} floor={host ? 100 : 0}>
    <p className="hint">{host ? 'Logical CPUs · host average is across all CPUs.' : 'Container total: 100% = one logical CPU. Per-core lines show where CPU time was used.'}</p>
    {!host && <p className="hint">{history.cpuSet == null ? 'Docker CPU pinning unavailable in the last observation.'
      : history.cpuSet ? `Last observed Docker CPU pinning: ${history.cpuSet}. Pinning limits where a container can run.`
        : 'Last observed: no Docker CPU pinning; the scheduler chooses CPUs.'}</p>}
    {cores.length > 0 ? <details className="cpu-series-controls">
      <summary>CPU series · {cores.filter((id) => selected.includes(id)).length} of {cores.length} cores shown</summary>
      <div className="btn-row">
        <button className="btn sm" onClick={() => onChoose(null)}>Show all cores</button>
        <button className="btn sm" onClick={() => onChoose([])}>Aggregate only</button>
      </div>
      <div className="cpu-series-options" role="group" aria-label="CPU cores to chart">
        {cores.map((id) => <label key={id}>
          <input type="checkbox" checked={selected.includes(id)} onChange={(e) => onChoose(e.target.checked ? [...selected, id] : selected.filter((core) => core !== id))} /> CPU {id}
        </label>)}
      </div>
    </details> : <p className="hint">{host ? 'Per-core history starts with new samples after this update.'
      : 'No per-core samples in this timeframe. Docker may not expose per-core usage on this host (common with cgroup v2).'}</p>}
  </Chart>;
}

export default function HistoryPanel({ target = 'host', onTargetChange, compact = false }) {
  const [range, setRange] = useState('7d');
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const [hover, setHover] = useState(null);
  const [retry, setRetry] = useState(0);
  const [chosenCores, setChosenCores] = useState(null); // null selects all observed CPUs
  useEffect(() => { setChosenCores(null); }, [target]);
  useEffect(() => {
    let stop = false, pending = false;
    setHistory(null);
    setError('');
    setHover(null);
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const data = await api.metrics(target, range);
        if (!stop) { setHistory(data); setError(''); }
      } catch (err) { if (!stop) setError(err.message); }
      finally { pending = false; }
    }
    poll();
    const timer = setInterval(poll, 30_000);
    return () => { stop = true; clearInterval(timer); };
  }, [target, range, retry]);
  const s = history?.summary;
  const host = target === 'host';
  const chart = (title, series, format, floor) => <Chart {...{ title, series, format, floor, history, hover }} onHover={setHover} />;
  return (
    <section className="history-panel" aria-label="Historical metrics">
      <div className="metrics-toolbar">
        <div className="btn-row">
          {onTargetChange ? <select aria-label="Metrics target" value={target} onChange={(e) => onTargetChange(e.target.value)}>
            <option value="host">Host</option>
            {target !== 'host' && !history?.targets.some((t) => t.target === target) && <option value={target}>{target.replace(/^container:/, '')}</option>}
            {history?.targets.filter((t) => t.target !== 'host').map((t) => <option key={t.target} value={t.target}>{t.name}</option>)}
          </select> : <strong>Metrics history</strong>}
          {compact && <Link to={`/metrics?target=${encodeURIComponent(target)}`}>Explore metrics →</Link>}
        </div>
        <div className="btn-row" role="group" aria-label="Timeframe">
          {['1h', '3h', '1d', '3d', '7d'].map((value) => <button key={value} className={`btn sm${range === value ? ' primary' : ''}`} aria-pressed={range === value} onClick={() => setRange(value)}>{value}</button>)}
        </div>
      </div>
      {error && <div className="notice err" role="alert">{error} <button className="btn sm" onClick={() => setRetry((r) => r + 1)}>Retry</button></div>}
      {!history && !error && <p className="dim" role="status">Loading metrics history…</p>}
      {history && <>
        <div className="metrics-caption dim">
          {stamp(history.from)} – {stamp(history.to)} · {history.retentionDays} day retention · sampled every {history.sampleSeconds}s
          {history.collector.lastSampleAt && <> · last sample {stamp(history.collector.lastSampleAt)}</>}
        </div>
        {history.collector.error && <div className="notice warn">{history.collector.error}</div>}
        {Date.now() - (history.collector.lastSampleAt || 0) > 90_000 && <div className="notice warn">Waiting for fresh observations. The collector may be unavailable.</div>}
        {!history.points.length && <div className="notice">No samples in this timeframe yet. Collection runs in the background while kissd is running; history starts after this feature is installed.</div>}
        {!compact && <div className="grid cols-4">
          <div className="card"><h3>{host ? 'Observation coverage' : 'Availability'}</h3><div className="stat-value">{pct(host ? s.observedMs / (history.to - history.from) * 100 : s.availabilityPercent)}</div><div className="stat-sub">{elapsed(s.observedMs)} observed · {elapsed(s.unknownMs)} unknown</div></div>
          <div className="card"><h3>{host ? 'Monitoring gaps' : 'Downtime'}</h3><div className="stat-value">{elapsed(host ? s.unknownMs : s.downMs)}</div><div className="stat-sub">{host ? 'Includes time before collection started' : `${s.incidents} observed interval${s.incidents === 1 ? '' : 's'} · unhealthy ${elapsed(s.unhealthyMs)}`}</div></div>
          <div className="card"><h3>CPU peak</h3><div className="stat-value">{pct(s.cpuPeak)}</div><div className="stat-sub">Average {pct(s.cpuAvg)}{!host && ' · 100% = one core'}</div></div>
          <div className="card"><h3>Memory peak</h3><div className="stat-value">{bytes(s.memoryPeak)}</div><div className="stat-sub">Average {bytes(s.memoryAvg)}{!host && ` · ${s.restarts} Docker restart${s.restarts === 1 ? '' : 's'}`}</div></div>
        </div>}
        <div className="card availability-card">
          <h3>Availability timeline</h3>
          <div className="availability-track" role="img" aria-label={`Availability timeline: ${elapsed(s.downMs)} down, ${elapsed(s.unhealthyMs)} unhealthy, ${elapsed(s.unknownMs)} unknown`}>
            {history.availability.map((a) => <span key={a.from} style={{ width: `${(a.to - a.from) / (history.to - history.from) * 100}%`, background: COLORS[a.state] }} title={`${LABELS[a.state]} · ${stamp(a.from)} – ${stamp(a.to)} (${elapsed(a.to - a.from)})`} />)}
          </div>
          <div className="availability-legend">{Object.entries(LABELS).map(([state, label]) => <span key={state}><i style={{ background: COLORS[state] }} />{label}</span>)}</div>
          <div className="hint">Container availability uses Docker state and healthchecks, not external HTTP probes. Gaps while kissd is offline are unknown. Outages shorter than 30s may be missed.</div>
        </div>
        <div className="grid cols-2 metrics-charts">
          <CpuChart {...{ history, host, hover }} onHover={setHover} chosen={chosenCores} onChoose={setChosenCores} />
          {chart('Memory usage', [{ key: 'memory', label: 'Memory', color: '#2ecc71' }], bytes)}
          {!compact && <>
            {chart('Network traffic', [{ key: 'rxRate', label: 'Receive', color: '#4f8cff' }, { key: 'txRate', label: 'Send', color: '#b18aff' }], speed)}
            {host ? chart('Disk & swap utilization', [{ key: 'diskPercent', label: 'Fullest disk', color: '#f5a623' }, { key: 'swapPercent', label: 'Swap', color: '#b18aff' }], pct, 100)
              : chart('Disk I/O', [{ key: 'readRate', label: 'Read', color: '#f5a623' }, { key: 'writeRate', label: 'Write', color: '#b18aff' }], speed)}
            {host ? chart('System load (1 minute)', [{ key: 'load', label: 'Load', color: '#f5a623' }], number)
              : chart('Process count', [{ key: 'pids', label: 'PIDs', color: '#f5a623' }], count)}
            {host && chart('Container fleet', [{ key: 'running', label: 'Running', color: '#2ecc71' }, { key: 'unhealthy', label: 'Unhealthy', color: '#f5a623' }], count)}
          </>}
        </div>
        {!compact && !host && <div className="card metrics-events">
          <h3>Downtime &amp; health incidents</h3>
          <p className="hint">Observed intervals, estimated to the 30s sample cadence. Latest 20; intentional stops are included.</p>
          {history.availability.some((a) => a.state === 'down' || a.state === 'unhealthy') ? <ul>
            {history.availability.filter((a) => a.state === 'down' || a.state === 'unhealthy').slice(-20).reverse().map((a) => <li key={a.from}>
              <span className={`pill ${a.state === 'down' ? 'exited' : 'restarting'}`}>{a.state === 'down' ? 'Down' : 'Unhealthy'}</span>
              <time dateTime={new Date(a.from).toISOString()}>{stamp(a.from)} – {stamp(a.to)}</time>
              <strong>{elapsed(a.to - a.from)}</strong>
              {a.to === history.to && <span className="dim">still observed</span>}
            </li>)}
          </ul> : <p className="dim">No downtime or unhealthy intervals observed.</p>}
        </div>}
        {!compact && <div className="card metrics-events">
          <h3>Observed events</h3>
          <p className="hint">State changes, Docker restarts and container replacements in this timeframe. Latest 100 events.</p>
          {history.events.length ? <ul>{history.events.map((event, i) => <li key={`${event.at}-${i}`}><time dateTime={new Date(event.at).toISOString()}>{stamp(event.at)}</time><span className={`pill ${event.type === 'down' ? 'exited' : event.type === 'recovered' ? 'running' : 'restarting'}`}>{event.type}</span><span>{event.detail}</span></li>)}</ul>
            : <p className="dim">No transitions observed in this timeframe.</p>}
        </div>}
      </>}
    </section>
  );
}
