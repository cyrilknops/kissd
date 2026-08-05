import { useState } from 'react';
import { api } from '../api';

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>kissd</h1>
        <p className="sub">Sign in to manage this server.</p>

        {error && <div className="notice err">{error}</div>}

        <div className="field">
          <label htmlFor="u">Username</label>
          <input id="u" type="text" value={username} autoComplete="username"
                 onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <input id="p" type="password" value={password} autoComplete="current-password" autoFocus
                 onChange={(e) => setPassword(e.target.value)} />
        </div>

        <button className="btn primary" style={{ width: '100%' }} disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
