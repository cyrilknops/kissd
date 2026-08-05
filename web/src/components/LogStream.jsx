import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api';

export default function LogStream({ containerId, tail = 400, style }) {
  const [text, setText] = useState('');
  const preRef = useRef(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    setText('');
    const ws = new WebSocket(wsUrl('/ws/logs', { id: containerId, tail }));
    ws.onmessage = (ev) => setText((t) => (t + ev.data).slice(-200000));
    ws.onerror = () => setText((t) => `${t}\n[log stream error]\n`);
    return () => ws.close();
  }, [containerId, tail]);

  useEffect(() => {
    const el = preRef.current;
    // Only autoscroll while the user is parked at the bottom, so scrolling up
    // to read something isn't yanked away by new output.
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  function onScroll() {
    const el = preRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  return (
    <pre className="stream" ref={preRef} onScroll={onScroll} style={style}>
      {text || 'Waiting for output…'}
    </pre>
  );
}
