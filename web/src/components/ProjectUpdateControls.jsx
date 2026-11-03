export default function ProjectUpdateControls({
  project,
  policy,
  onUpdate,
  onRestart,
  short = false,
}) {
  const guarded = policy?.mode === 'guarded';
  const blocked = policy?.mode === 'blocked';
  return (
    <>
      <button
        className="btn xs"
        disabled={blocked}
        onClick={onUpdate}
        title={
          blocked
            ? 'Update policy needs attention'
            : guarded
              ? policy.tracksLatest
                ? 'Pull latest application images with backup, health checks and rollback; the database stays unchanged'
                : 'Update the approved application release with backup and health checks; the database stays unchanged'
              : `Pull and recreate services in ${project}`
        }
      >
        {guarded ? policy.tracksLatest ? 'Update latest' : 'Guarded update' : short ? 'Update' : 'Update all'}
      </button>
      <button
        className="btn xs"
        disabled={Boolean(policy)}
        onClick={onRestart}
        title={
          policy
            ? 'Use the guarded update to keep protected services unchanged'
            : `Stop and start containers in ${project}`
        }
      >
        {short ? 'Restart' : 'Restart all'}
      </button>
    </>
  );
}
