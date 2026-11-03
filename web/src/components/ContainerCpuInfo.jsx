// Affinity is a scheduling limit, not evidence that a CPU ran this container.
export default function ContainerCpuInfo({ stats, cpuSet = null, running = true }) {
  const pinning = cpuSet ?? stats?.cpuSet ?? null;
  const cores = stats?.cpuPerCore;
  const used = cores?.filter((core) => core.percent > 0) || [];
  const names = used.map((core) => `CPU ${core.id}`);
  const missing = cores?.some((core) => core.percent == null);
  return <div className="cpu-placement dim">
    <div>{pinning == null ? 'Docker CPU pinning unavailable'
      : pinning ? `Docker CPU pinning: ${pinning}` : 'No Docker CPU pinning; scheduler chooses CPUs'}</div>
    {running && <div title={names.join(', ')}>{!stats ? 'Waiting for CPU sample'
      : cores == null ? 'Per-core usage unavailable from Docker'
        : !cores.some((core) => core.percent != null) ? 'Waiting for per-core sample'
          : used.length ? `Used last sample: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8} more` : ''}${missing ? ' · other cores unknown' : ''}`
            : missing ? 'Some core readings unavailable in last sample' : 'No CPU activity in last sample'}</div>}
  </div>;
}
