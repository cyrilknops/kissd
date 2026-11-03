import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, bytes, ago } from '../api';
import StreamModal from '../components/StreamModal';
import ConfirmRestart from '../components/ConfirmRestart';
import ProjectUpdateControls from '../components/ProjectUpdateControls';
import ContainerCpuInfo from '../components/ContainerCpuInfo';

const UNGROUPED = '\u0000ungrouped'; // sorts last; never collides with a project name
const COLLAPSE_KEY = 'kissd.collapsedProjects';
const GROUPING_KEY = 'kissd.groupByProject';

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function usagePercent(stats) {
  if (!stats?.memoryLimit) return 0;
  return Math.min(100, (stats.memory / stats.memoryLimit) * 100);
}

function ContainerCard({ c, busy, onAction }) {
  const navigate = useNavigate();
  const pct = usagePercent(c.stats);

  return (
    <div className="ctr-card">
      <div className="ctr-head">
        <Link to={`/containers/${c.name}`} className="ctr-name" title={c.name}>
          {c.name}
        </Link>
        <span className={`pill ${c.state}`}>
          <span className="dot" />
          {c.state}
        </span>
      </div>

      <div className="ctr-image mono" title={c.image}>
        {c.image}
      </div>

      <div className="ctr-meta">
        <div>
          <span className="dim">CPU</span>
          <strong>{c.stats?.cpu != null ? `${c.stats.cpu.toFixed(1)}%` : '—'}</strong>
        </div>
        <div>
          <span className="dim">Memory</span>
          <strong>{c.stats ? bytes(c.stats.memory) : '—'}</strong>
        </div>
        <div>
          <span className="dim">Uptime</span>
          <strong>{c.state === 'running' ? ago(c.created) : '—'}</strong>
        </div>
        <div>
          <span className="dim">Health</span>
          <strong className={c.health === 'unhealthy' ? 'bad' : undefined}>
            {c.health || '—'}
          </strong>
        </div>
      </div>

      {c.stats && (
        <div className="bar">
          <i
            className={pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : ''}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {c.state === 'running' && c.stats && <ContainerCpuInfo stats={c.stats} />}

      {c.ports.length > 0 && (
        <div className="ctr-ports mono dim" title={c.ports.join(', ')}>
          {c.ports.join('  ')}
        </div>
      )}

      <div className="ctr-actions">
        {c.state === 'running' ? (
          <>
            <button className="btn xs" disabled={!!busy} onClick={() => onAction(c, 'restart')}>
              {busy === 'restart' ? '…' : 'Restart'}
            </button>
            <button className="btn xs danger" disabled={!!busy} onClick={() => onAction(c, 'stop')}>
              {busy === 'stop' ? '…' : 'Stop'}
            </button>
          </>
        ) : (
          <button className="btn xs" disabled={!!busy} onClick={() => onAction(c, 'start')}>
            {busy === 'start' ? '…' : 'Start'}
          </button>
        )}
        <button
          className="btn xs primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => navigate(`/containers/${c.name}`)}
        >
          Details →
        </button>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="ctr-card skeleton" aria-hidden="true">
      <div className="ctr-head">
        <span className="sk sk-name" />
        <span className="sk sk-pill" />
      </div>
      <span className="sk sk-line" />
      <div className="ctr-meta">
        <span className="sk sk-line short" />
        <span className="sk sk-line short" />
        <span className="sk sk-line short" />
        <span className="sk sk-line short" />
      </div>
      <div className="ctr-actions">
        <span className="sk sk-btn" />
        <span className="sk sk-btn" />
      </div>
    </div>
  );
}

function GroupHeader({ name, items, collapsed, onToggle, onUpdate, onRestart }) {
  const running = items.filter((c) => c.state === 'running').length;
  const unhealthy = items.filter((c) => c.health === 'unhealthy').length;
  const memory = items.reduce((a, c) => a + (c.stats?.memory || 0), 0);
  const cpu = items.reduce((a, c) => a + (c.stats?.cpu || 0), 0);
  const allRunning = running === items.length;
  const isProject = name !== UNGROUPED;

  return (
    <div className="group-head">
      <button className="group-head-toggle" onClick={onToggle} aria-expanded={!collapsed}>
        <span className={`chev${collapsed ? '' : ' open'}`}>▸</span>
        <span className="group-name">{isProject ? name : 'Not managed by compose'}</span>
        <span className={`pill ${allRunning ? 'running' : 'exited'}`} style={{ fontSize: 11 }}>
          {running}/{items.length} running
        </span>
        {unhealthy > 0 && (
          <span className="pill unhealthy" style={{ fontSize: 11 }}>
            {unhealthy} unhealthy
          </span>
        )}
        <span className="group-stats dim">
          {cpu > 0 && <>{cpu.toFixed(1)}% CPU</>}
          {memory > 0 && <> · {bytes(memory)}</>}
        </span>
      </button>
      {isProject && (
        <div className="btn-row" style={{ gap: 6 }}>
          <ProjectUpdateControls
            project={name}
            policy={items[0]?.compose?.updatePolicy}
            onUpdate={onUpdate}
            onRestart={onRestart}
          />
        </div>
      )}
    </div>
  );
}

export default function Containers({ containers, reload, loaded }) {
  const [busy, setBusy] = useState({});
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [updating, setUpdating] = useState(null);
  const [restarting, setRestarting] = useState(null); // project awaiting confirmation
  const [restartingRun, setRestartingRun] = useState(null);
  const [grouped, setGrouped] = useState(() => loadJson(GROUPING_KEY, true));
  const [collapsed, setCollapsed] = useState(() => loadJson(COLLAPSE_KEY, {}));

  function persistCollapsed(next) {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      // Private mode or storage full — grouping still works, it just won't stick.
    }
  }

  function toggleGrouping() {
    const next = !grouped;
    setGrouped(next);
    try {
      localStorage.setItem(GROUPING_KEY, JSON.stringify(next));
    } catch {
      // Non-fatal.
    }
  }

  async function onAction(c, action) {
    setBusy((b) => ({ ...b, [c.id]: action }));
    setError('');
    try {
      await api.containerAction(c.id, action);
      await reload();
    } catch (err) {
      setError(`${c.name}: ${err.message}`);
    } finally {
      setBusy((b) => ({ ...b, [c.id]: null }));
    }
  }

  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      containers.filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          c.image.toLowerCase().includes(q) ||
          (c.compose?.project || '').toLowerCase().includes(q),
      ),
    [containers, q],
  );

  const groups = useMemo(() => {
    const map = new Map();
    for (const c of shown) {
      const key = c.compose?.project || UNGROUPED;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    for (const items of map.values()) items.sort((a, b) => a.name.localeCompare(b.name));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  const running = containers.filter((c) => c.state === 'running').length;
  // While filtering, collapsed groups would hide the very matches being looked
  // for, so filtering temporarily expands everything.
  const forceOpen = q.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Containers</h1>
          <p>
            {loaded
              ? `${containers.length} total · ${running} running${grouped ? ` · ${groups.length} project${groups.length === 1 ? '' : 's'}` : ''}`
              : 'Loading…'}
          </p>
        </div>
        <div className="btn-row" style={{ alignItems: 'center' }}>
          <button
            className="btn sm"
            onClick={toggleGrouping}
            title="Toggle grouping by compose project"
          >
            {grouped ? 'Ungroup' : 'Group by project'}
          </button>
          {grouped && (
            <button
              className="btn sm"
              onClick={() =>
                persistCollapsed(
                  Object.keys(collapsed).length
                    ? {}
                    : Object.fromEntries(groups.map(([k]) => [k, true])),
                )
              }
            >
              {Object.keys(collapsed).length ? 'Expand all' : 'Collapse all'}
            </button>
          )}
          <input
            type="search"
            className="filter-input"
            placeholder="Filter name, image or project…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="notice err">{error}</div>}

      {!loaded && (
        <div className="card-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {loaded && !grouped && (
        <div className="card-grid">
          {shown.map((c) => (
            <ContainerCard key={c.id} c={c} busy={busy[c.id]} onAction={onAction} />
          ))}
        </div>
      )}

      {loaded &&
        grouped &&
        groups.map(([name, items]) => {
          const isCollapsed = !forceOpen && collapsed[name];
          return (
            <section key={name} className="group">
              <GroupHeader
                name={name}
                items={items}
                collapsed={isCollapsed}
                onToggle={() => persistCollapsed({ ...collapsed, [name]: !collapsed[name] })}
                onUpdate={() => setUpdating(name)}
                onRestart={() =>
                  setRestarting({
                    project: name,
                    // Distinct compose services, not containers: a scaled service
                    // is several containers but one line in the compose file.
                    services: new Set(items.map((c) => c.compose?.service).filter(Boolean)).size,
                    hasSelf: items.some((c) => c.isSelf),
                  })
                }
              />
              {!isCollapsed && (
                <div className="card-grid">
                  {items.map((c) => (
                    <ContainerCard key={c.id} c={c} busy={busy[c.id]} onAction={onAction} />
                  ))}
                </div>
              )}
            </section>
          );
        })}

      {loaded && !shown.length && (
        <p className="dim">
          {containers.length ? 'No containers match that filter.' : 'No containers on this host.'}
        </p>
      )}

      {updating && (
        <StreamModal
          title={`docker compose pull && up -d · ${updating}`}
          url="/api/compose/update"
          body={{ project: updating }}
          onClose={() => setUpdating(null)}
          onDone={reload}
        />
      )}

      {restarting && (
        <ConfirmRestart
          project={restarting.project}
          services={restarting.services}
          hasSelf={restarting.hasSelf}
          onCancel={() => setRestarting(null)}
          onConfirm={() => {
            setRestartingRun(restarting.project);
            setRestarting(null);
          }}
        />
      )}

      {restartingRun && (
        <StreamModal
          title={`docker compose restart · ${restartingRun}`}
          url="/api/compose/restart"
          body={{ project: restartingRun }}
          onClose={() => setRestartingRun(null)}
          onDone={reload}
        />
      )}
    </>
  );
}
