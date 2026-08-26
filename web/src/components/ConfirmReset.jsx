import Modal from './Modal';

// A reset is `docker compose down && up -d`: every service in the project goes
// away and comes back. That is a bigger hammer than Update, so it asks first.
export default function ConfirmReset({ project, services, hasSelf, onCancel, onConfirm }) {
  return (
    <Modal
      title={`Reset ${project}?`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onConfirm}>Reset now</button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Runs <span className="mono">docker compose down</span> and then{' '}
        <span className="mono">docker compose up -d</span> for the whole project, so every
        container is recreated from the compose file exactly as it stands on disk.
        Nothing is pulled — the images you have now are the images you get back.
      </p>
      <div className="notice warn">
        {services ? `All ${services} service${services === 1 ? '' : 's'} in` : 'Everything in'}{' '}
        <strong>{project}</strong> is down for the length of the run. Named volumes are left
        alone, so the data in them survives.
      </div>
      {hasSelf && (
        <p className="hint">
          This project runs kissd itself, so the run is handed to the host and recreates each
          container in place instead of taking the project down first — a detached run cannot
          be relied on to outlive kissd, and a half-finished <span className="mono">down</span>{' '}
          would leave everything stopped. The panel will drop out for a few seconds.
        </p>
      )}
    </Modal>
  );
}
