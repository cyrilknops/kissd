import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { watchInstallPrompt } from './pwa';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Containers from './pages/Containers';
import ContainerDetail from './pages/ContainerDetail';
import Terminals from './pages/Terminals';
import Compose from './pages/Compose';
import Maintenance from './pages/Maintenance';
import Settings from './pages/Settings';

const NAV = [
  { to: '/', label: 'Overview', icon: '◎', end: true },
  { to: '/containers', label: 'Containers', icon: '▦' },
  { to: '/compose', label: 'Compose', icon: '≡' },
  { to: '/terminal', label: 'Terminal', icon: '❯' },
  { to: '/maintenance', label: 'Maintenance', icon: '⛁' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [authed, setAuthed] = useState(null);
  const [containers, setContainers] = useState([]);
  const [containersLoaded, setContainersLoaded] = useState(false);
  const [pendingShell, setPendingShell] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const drawerCloseRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      setContainers(await api.containers());
      setContainersLoaded(true);
    } catch (err) {
      if (err.status === 401) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    api.me().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return undefined;
    reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [authed, reload]);

  useEffect(() => watchInstallPrompt(setInstallPrompt), []);

  // The drawer is a navigation aid, so arriving somewhere is what dismisses it.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return undefined;
    drawerCloseRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (authed === null) return null;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;

  async function logout() {
    await api.logout().catch(() => {});
    setAuthed(false);
    navigate('/', { replace: true });
  }

  async function install() {
    const prompt = installPrompt;
    setInstallPrompt(null);
    await prompt.prompt();
  }

  const unhealthy = containers.filter((c) => c.health === 'unhealthy' || c.state === 'exited').length;
  const onTerminal = location.pathname === '/terminal';
  const current = NAV.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      {/* Replaces the sidebar on narrow screens; hidden by CSS on wide ones. */}
      <header className="topbar">
        {/* Stays "open" even while the drawer is out, because the drawer
            covers this button — closing happens from inside it, the backdrop
            or Escape. */}
        <button
          className="icon-btn"
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          aria-expanded={navOpen}
          aria-controls="sidebar"
        >
          <span aria-hidden="true">☰</span>
        </button>
        <span className="topbar-title">
          <span className="dot" />
          {current?.label || 'kissd'}
        </span>
        {unhealthy > 0 && (
          <span className="pill exited" style={{ marginLeft: 'auto' }}>{unhealthy} down</span>
        )}
      </header>

      <button
        className="nav-backdrop"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setNavOpen(false)}
      />

      <aside className="sidebar" id="sidebar">
        <div className="brand">
          <span className="dot" />
          <span>
            kissd
            <small>keep it super simple</small>
            <small className="version">v{__APP_VERSION__}</small>
          </span>
          <button
            ref={drawerCloseRef}
            className="icon-btn drawer-close"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true">{n.icon}</span>
            {n.label}
            {n.to === '/containers' && unhealthy > 0 && (
              <span className="pill exited" style={{ marginLeft: 'auto', fontSize: 11 }}>{unhealthy}</span>
            )}
          </NavLink>
        ))}

        <div className="sidebar-foot">
          {installPrompt && (
            <button className="btn sm" style={{ width: '100%', marginBottom: 6 }} onClick={install}>
              Install app
            </button>
          )}
          <button className="btn sm" style={{ width: '100%' }} onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Overview containers={containers} />} />
          <Route path="/containers" element={<Containers containers={containers} reload={reload} loaded={containersLoaded} />} />
          <Route path="/containers/:id" element={<ContainerDetail onOpenShell={setPendingShell} />} />
          {/* Rendered by the persistent block below, not here — routing to it
              must not unmount the open shells. */}
          <Route path="/terminal" element={null} />
          <Route path="/compose" element={<Compose />} />
          <Route path="/maintenance" element={<Maintenance />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>

        {/* Kept mounted across navigation so shells and Claude sessions survive. */}
        <div style={{ display: onTerminal ? 'block' : 'none' }}>
          <Terminals
            containers={containers}
            pendingShell={pendingShell}
            clearPendingShell={() => setPendingShell(null)}
          />
        </div>
      </main>
    </div>
  );
}
