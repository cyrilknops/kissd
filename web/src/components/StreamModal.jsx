import { useEffect, useRef, useState } from 'react';
import { streamPost } from '../api';
import Modal from './Modal';

// Runs a streaming POST and shows its output as it arrives. Closing is blocked
// while it runs, so a compose run is never abandoned half-read.
export default function StreamModal({ title, url, body, onClose, onDone }) {
  const [log, setLog] = useState('');
  const [running, setRunning] = useState(true);
  const preRef = useRef(null);
  const payload = JSON.stringify(body ?? null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await streamPost(url, (chunk) => {
          if (!cancelled) setLog((t) => t + chunk);
        }, JSON.parse(payload));
      } catch (err) {
        if (!cancelled) setLog((t) => `${t}\n${err.message}\n`);
      } finally {
        if (!cancelled) {
          setRunning(false);
          onDone?.();
        }
      }
    })();
    return () => { cancelled = true; };
    // onDone is called once at the end; re-running on its identity would
    // restart the stream on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, payload]);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [log]);

  return (
    <Modal title={title} onClose={running ? () => {} : onClose} flush
           footer={<button className="btn" onClick={onClose} disabled={running}>
             {running ? 'Running…' : 'Close'}
           </button>}>
      <pre className="stream" ref={preRef} style={{ maxHeight: '50vh' }}>{log || 'Starting…'}</pre>
    </Modal>
  );
}
