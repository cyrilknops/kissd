import { useEffect } from 'react';

export default function Modal({ title, onClose, children, footer, flush }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h2>{title}</h2>
          <button className="close-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className={`body${flush ? ' flush' : ''}`}>{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}
