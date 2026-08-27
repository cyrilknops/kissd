import Modal from './Modal';

// One click here bounces a whole stack, so it asks first — unlike the per-
// container Restart button, which only ever affects the card it sits on.
export default function ConfirmRestart({ project, services, hasSelf, onCancel, onConfirm }) {
  return (
    <Modal
      title={`Restart ${project}?`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onConfirm}>Restart now</button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Runs <span className="mono">docker compose restart</span> for the whole project:
        every container stops and starts again, keeping the image, the volumes and the
        container itself exactly as they are.
      </p>
      <p className="dim">
        {services ? `All ${services} service${services === 1 ? '' : 's'} in` : 'Everything in'}{' '}
        <strong>{project}</strong> is briefly unavailable. Nothing is pulled and nothing is
        recreated, so an edit to the compose file since these containers were created is{' '}
        <em>not</em> picked up — use Update or Save &amp; apply for that.
      </p>
      {hasSelf && (
        <p className="hint">
          This project runs kissd itself, so the run is handed to the host to survive kissd
          restarting. The panel will drop out for a few seconds.
        </p>
      )}
    </Modal>
  );
}
