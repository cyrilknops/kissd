import { useEffect, useState } from 'react';
import { api } from '../api';

function Num({ label, value, onChange, min, max, suffix, hint }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" value={value} min={min} max={max}
               onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="dim" style={{ whiteSpace: 'nowrap' }}>{suffix}</span>}
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export default function Settings() {
  const [s, setS] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [alertLog, setAlertLog] = useState([]);
  const [muted, setMuted] = useState([]);
  const [logins, setLogins] = useState(null);

  useEffect(() => {
    api.settings().then(setS).catch((e) => setStatus({ type: 'err', text: e.message }));
    api.alerts().then((a) => {
      setAlertLog(a.log || []);
      setMuted(a.muted || []);
    }).catch(() => {});
  }, []);

  if (!s) return <p className="dim">Loading settings…</p>;

  const ntfy = s.ntfy;
  const alerts = s.alerts;
  const registries = s.registries || [];

  const patch = (section, changes) => setS({ ...s, [section]: { ...s[section], ...changes } });
  const patchNested = (section, key, changes) =>
    setS({ ...s, [section]: { ...s[section], [key]: { ...s[section][key], ...changes } } });

  const patchRegistry = (i, changes) => setS({
    ...s,
    registries: registries.map((r, n) => (n === i ? { ...r, ...changes } : r)),
  });
  const addRegistry = () => setS({
    ...s,
    registries: [...registries, { server: '', username: '', password: '', passwordSet: false }],
  });
  const removeRegistry = (i) => setS({ ...s, registries: registries.filter((_, n) => n !== i) });

  // Secrets are only transmitted when the user actually typed a new value.
  function buildPatch() {
    const out = structuredClone(s);
    delete out.ntfy.tokenSet;
    delete out.ntfy.tokenHint;
    delete out.ntfy.passwordSet;
    delete out.ntfy.passwordHint;
    out.registries = (out.registries || []).map(({ server, username, password }) =>
      ({ server, username, password }));
    return out;
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const updated = await api.saveSettings(buildPatch());
      setS(updated);
      setStatus({ type: 'ok', text: 'Settings saved. The alert watcher picked them up immediately.' });
    } catch (err) {
      setStatus({ type: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    try {
      await api.testNtfy(buildPatch().ntfy);
      setStatus({ type: 'ok', text: 'Test notification sent — check your ntfy client.' });
    } catch (err) {
      setStatus({ type: 'err', text: `Test failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function testLogins() {
    setBusy(true);
    setStatus(null);
    setLogins(null);
    try {
      const { results } = await api.testRegistries(buildPatch().registries);
      setLogins(results);
    } catch (err) {
      setStatus({ type: 'err', text: `Test failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  const configured = ntfy.url && ntfy.topic;
  const testable = registries.some((r) => r.server && r.username && (r.password || r.passwordSet));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Notifications and alert thresholds. Changes apply without a restart.</p>
        </div>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {status && <div className={`notice ${status.type}`}>{status.text}</div>}
      {!configured && (
        <div className="notice warn">
          Notifications are not configured yet — set your ntfy server URL and topic below.
          Alerts will still show up here, but nothing will be pushed.
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h3>ntfy server</h3>
          <div className="field">
            <label>Server URL</label>
            <input type="text" placeholder="https://ntfy.example.com" value={ntfy.url}
                   onChange={(e) => patch('ntfy', { url: e.target.value })} />
            <div className="hint">Base URL of your ntfy instance, without the topic.</div>
          </div>
          <div className="field">
            <label>Topic</label>
            <input type="text" placeholder="my-server" value={ntfy.topic}
                   onChange={(e) => patch('ntfy', { topic: e.target.value })} />
          </div>
          <div className="field">
            <label>Authentication</label>
            <select value={ntfy.auth} onChange={(e) => patch('ntfy', { auth: e.target.value })}>
              <option value="none">None</option>
              <option value="token">Access token</option>
              <option value="basic">Username &amp; password</option>
            </select>
          </div>

          {ntfy.auth === 'token' && (
            <div className="field">
              <label>Access token</label>
              <input type="password" placeholder={ntfy.tokenSet ? `saved (${ntfy.tokenHint})` : 'tk_…'}
                     value={ntfy.token} onChange={(e) => patch('ntfy', { token: e.target.value })} />
              <div className="hint">
                {ntfy.tokenSet
                  ? 'A token is saved. Leave blank to keep it, type to replace it.'
                  : 'Stored server-side only; never sent back to the browser.'}
                {ntfy.tokenSet && (
                  <> · <a href="#clear" onClick={(e) => { e.preventDefault(); patch('ntfy', { token: '__CLEAR__' }); }}>Clear</a></>
                )}
              </div>
            </div>
          )}

          {ntfy.auth === 'basic' && (
            <div className="row">
              <div className="field">
                <label>Username</label>
                <input type="text" value={ntfy.username}
                       onChange={(e) => patch('ntfy', { username: e.target.value })} />
              </div>
              <div className="field">
                <label>Password</label>
                <input type="password" placeholder={ntfy.passwordSet ? `saved (${ntfy.passwordHint})` : ''}
                       value={ntfy.password} onChange={(e) => patch('ntfy', { password: e.target.value })} />
              </div>
            </div>
          )}

          {/* Tests what's currently on screen, including unsaved edits, so you
              can verify a server before committing it. */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 14 }}>
            <div className="btn-row" style={{ alignItems: 'center' }}>
              <button className="btn" onClick={test} disabled={busy || !configured}>
                {busy ? 'Sending…' : 'Send test notification'}
              </button>
              {!configured && <span className="dim" style={{ fontSize: 12 }}>Needs a server URL and topic first.</span>}
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              Sends a notification using the values above, saved or not. If it arrives,
              the panel can reach your ntfy server.
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Alerting</h3>
          <div className="check">
            <input type="checkbox" id="a-en" checked={alerts.enabled}
                   onChange={(e) => patch('alerts', { enabled: e.target.checked })} />
            <label htmlFor="a-en" style={{ margin: 0 }}>Enable the alert watcher</label>
          </div>

          <Num label="Check interval" value={alerts.pollSeconds} min={10} max={3600} suffix="seconds"
               onChange={(v) => patch('alerts', { pollSeconds: v })} />
          <Num label="Re-alert cooldown" value={alerts.cooldownSeconds} min={60} suffix="seconds"
               hint="How long before the same threshold alert is sent again."
               onChange={(v) => patch('alerts', { cooldownSeconds: v })} />
          <Num label="Recovery hysteresis" value={alerts.hysteresis} min={0} max={50} suffix="points"
               hint="A value must drop this far below the threshold before it counts as recovered."
               onChange={(v) => patch('alerts', { hysteresis: v })} />
        </div>

        <div className="card">
          <h3>Container alerts</h3>
          <div className="check">
            <input type="checkbox" id="c-down" checked={alerts.containerDown}
                   onChange={(e) => patch('alerts', { containerDown: e.target.checked })} />
            <label htmlFor="c-down" style={{ margin: 0 }}>Container stopped or came back</label>
          </div>
          <div className="check">
            <input type="checkbox" id="c-un" checked={alerts.containerUnhealthy}
                   onChange={(e) => patch('alerts', { containerUnhealthy: e.target.checked })} />
            <label htmlFor="c-un" style={{ margin: 0 }}>Healthcheck failing</label>
          </div>
          <div className="check">
            <input type="checkbox" id="c-loop" checked={alerts.restartLoop}
                   onChange={(e) => patch('alerts', { restartLoop: e.target.checked })} />
            <label htmlFor="c-loop" style={{ margin: 0 }}>Restart loop detected</label>
          </div>

          {alerts.restartLoop && (
            <div className="row" style={{ marginTop: 6 }}>
              <Num label="Restarts" value={alerts.restartThreshold} min={1} max={50}
                   onChange={(v) => patch('alerts', { restartThreshold: v })} />
              <Num label="Within" value={alerts.restartWindowMinutes} min={1} max={1440} suffix="min"
                   onChange={(v) => patch('alerts', { restartWindowMinutes: v })} />
            </div>
          )}

          <p className="hint" style={{ marginTop: 10 }}>
            Restarts are counted over a rolling window, so a slow loop — a few restarts an
            hour — is caught as well as a fast one. Down and unhealthy alerts fire on state
            changes, so a container you stopped on purpose won't keep nagging.
          </p>

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
            <div className="check">
              <input type="checkbox" id="c-mute" checked={alerts.muteDuringUpdates !== false}
                     onChange={(e) => patch('alerts', { muteDuringUpdates: e.target.checked })} />
              <label htmlFor="c-mute" style={{ margin: 0 }}>Mute while updating</label>
            </div>

            {alerts.muteDuringUpdates !== false && (
              <Num label="Settle grace" value={alerts.muteGraceSeconds} min={0} max={3600} suffix="seconds"
                   hint="How long alerts stay muted after the compose run itself finishes."
                   onChange={(v) => patch('alerts', { muteGraceSeconds: v })} />
            )}

            <p className="hint" style={{ marginTop: 10 }}>
              An update, an apply or a reset stops and recreates containers on purpose, so no
              push goes out for the container or project being worked on while the run is in
              flight. The pre-update state stays the baseline, so a service that never comes
              back is still reported once the mute lifts.
            </p>

            {muted.length > 0 && (
              <div className="notice warn" style={{ marginTop: 10 }}>
                Muted right now:{' '}
                {muted.map((m) => m.key.replace(/^(container|project):/, '')).join(', ')}.
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3>Resource thresholds</h3>
          <div className="check">
            <input type="checkbox" id="t-disk" checked={alerts.disk.enabled}
                   onChange={(e) => patchNested('alerts', 'disk', { enabled: e.target.checked })} />
            <label htmlFor="t-disk" style={{ margin: 0 }}>Disk usage</label>
          </div>
          <Num label="Disk threshold" value={alerts.disk.threshold} min={1} max={99} suffix="%"
               onChange={(v) => patchNested('alerts', 'disk', { threshold: v })} />

          <div className="check">
            <input type="checkbox" id="t-mem" checked={alerts.memory.enabled}
                   onChange={(e) => patchNested('alerts', 'memory', { enabled: e.target.checked })} />
            <label htmlFor="t-mem" style={{ margin: 0 }}>Memory usage</label>
          </div>
          <Num label="Memory threshold" value={alerts.memory.threshold} min={1} max={99} suffix="%"
               onChange={(v) => patchNested('alerts', 'memory', { threshold: v })} />

          <div className="check">
            <input type="checkbox" id="t-load" checked={alerts.load.enabled}
                   onChange={(e) => patchNested('alerts', 'load', { enabled: e.target.checked })} />
            <label htmlFor="t-load" style={{ margin: 0 }}>Load average (1m)</label>
          </div>
          <Num label="Load threshold" value={alerts.load.threshold} min={0} step={0.5}
               onChange={(v) => patchNested('alerts', 'load', { threshold: v })} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Container registries</h3>
        <p className="hint" style={{ marginTop: -4, marginBottom: 14 }}>
          Docker keeps registry logins per client, so a <code>docker login</code> run over SSH is
          invisible to the panel — a private image pulls fine from a host shell and fails here with
          “no basic auth credentials”. Credentials added below are written to a config that every
          docker the panel runs points at, so one login covers container updates, project updates
          and compose apply alike.
        </p>

        {registries.map((r, i) => (
          <div key={i} className="registry-row">
            <div className="field">
              <label>Registry</label>
              <input type="text" placeholder="registry.example.com" value={r.server}
                     onChange={(e) => patchRegistry(i, { server: e.target.value })} />
              <div className="hint">Host only — no https:// and no image path.</div>
            </div>
            <div className="field">
              <label>Username</label>
              <input type="text" value={r.username}
                     onChange={(e) => patchRegistry(i, { username: e.target.value })} />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={r.password}
                     placeholder={r.passwordSet ? `saved (${r.passwordHint})` : 'password or access token'}
                     onChange={(e) => patchRegistry(i, { password: e.target.value })} />
              {r.passwordSet && (
                <div className="hint">
                  Leave blank to keep it, type to replace it ·{' '}
                  <a href="#clear" onClick={(e) => { e.preventDefault(); patchRegistry(i, { password: '__CLEAR__' }); }}>Clear</a>
                </div>
              )}
            </div>
            <button className="btn xs danger" onClick={() => removeRegistry(i)}>Remove</button>
          </div>
        ))}

        {!registries.length && (
          <p className="dim" style={{ margin: '0 0 14px' }}>
            None configured. Public images pull without any of this.
          </p>
        )}

        <div className="btn-row" style={{ alignItems: 'center' }}>
          <button className="btn" onClick={addRegistry}>Add registry</button>
          <button className="btn" onClick={testLogins} disabled={busy || !testable}>
            {busy ? 'Checking…' : 'Test logins'}
          </button>
          {!testable && registries.length > 0 && (
            <span className="dim" style={{ fontSize: 12 }}>Each row needs a server, username and password.</span>
          )}
        </div>

        {logins && (
          <div style={{ marginTop: 12 }}>
            {logins.map((l) => (
              <div key={l.server} className="hint" style={{ marginTop: 4 }}>
                {l.ok ? '✓' : '✗'} <strong>{l.server}</strong>
                {l.ok ? ' — signed in' : ` — ${l.error}`}
              </div>
            ))}
          </div>
        )}

        <p className="hint" style={{ marginTop: 14 }}>
          Passwords are stored server-side in a 0600 file on the data volume and never sent back to
          the browser. Save changes to apply them; a removed registry loses its credential too.
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Recent alerts</h3>
        {alertLog.length ? (
          <div className="table-wrap" style={{ border: 0 }}>
            <table style={{ minWidth: 0 }}>
              <tbody>
                {alertLog.slice(0, 25).map((a, i) => (
                  <tr key={i} style={a.muted ? { opacity: 0.7 } : undefined}>
                    <td className="dim" style={{ width: 160 }}>{new Date(a.at).toLocaleString()}</td>
                    <td className="name">{a.title}</td>
                    <td className="dim" style={{ whiteSpace: 'pre-wrap' }}>{a.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="dim" style={{ margin: 0 }}>Nothing yet — that's the good outcome.</p>
        )}
      </div>
    </>
  );
}
