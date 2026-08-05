import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from '../api';

const THEME = {
  background: '#0a0c11',
  foreground: '#cdd3e0',
  cursor: '#4f8cff',
  selectionBackground: '#2a3348',
  black: '#0a0c11',
  red: '#ef4757',
  green: '#2ecc71',
  yellow: '#f5a623',
  blue: '#4f8cff',
  magenta: '#b57edc',
  cyan: '#4dd0e1',
  white: '#cdd3e0',
};

// One xterm instance bound to one websocket. Remounting (via a changed `key`)
// is what starts a fresh session.
export default function XTerm({ params, onClosed }) {
  const hostRef = useRef(null);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // Element not laid out yet.
      }
    };
    safeFit();

    const ws = new WebSocket(wsUrl('/ws/terminal', params));
    let alive = false;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ r: [term.cols, term.rows] }));
      }
    };

    ws.onopen = () => {
      alive = true;
      sendResize();
      term.focus();
    };
    ws.onmessage = (ev) => term.write(ev.data);
    ws.onerror = () => term.write('\r\n\x1b[31mConnection error.\x1b[0m\r\n');
    ws.onclose = () => {
      if (!alive) {
        term.write('\r\n\x1b[31mConnection refused — your session may have expired.\x1b[0m\r\n');
      }
      closedRef.current?.();
    };

    const disposeData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ i: data }));
    });

    const onResize = () => {
      safeFit();
      sendResize();
    };
    window.addEventListener('resize', onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(hostRef.current);

    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      disposeData.dispose();
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="term-host" ref={hostRef} />;
}
