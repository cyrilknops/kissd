// Resolve mutable tags once; container replacement always uses immutable digests.
const digest = /^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)@sha256:[a-f0-9]{64}$/;
const latest = /^([a-zA-Z0-9][a-zA-Z0-9._:/-]*):latest$/;
export function validTracking(policy) {
  return policy.imageTags && typeof policy.imageTags === 'object' &&
    Object.keys(policy.imageTags).length === policy.services.length &&
    policy.services.every(s => {
      const tag = latest.exec(policy.imageTags[s] || '');
      return tag && tag[1] === digest.exec(policy.approvedImages?.[s] || '')?.[1];
    });
}
export async function resolveLatest(policy, config, run, emit) {
  if (!validTracking(policy)) throw Error('Latest tracking requires approved repositories');
  for (const service of policy.services) {
    const source = digest.exec(config.services?.[service]?.image || '');
    if (!source) throw Error('Current application sources must be pinned');
    if (source[1] !== latest.exec(policy.imageTags[service])[1])
      throw Error('Latest image repository differs from the configured source');
  }
  const resolved = new Map();
  let revision;
  for (const tag of new Set(Object.values(policy.imageTags))) {
    emit('Fetching latest application image…\n');
    try { await run(['docker','pull',tag],{timeoutMs:300000}); }
    catch { throw Error('Latest image pull failed; no services changed'); }
    const value = JSON.parse((await run(['docker','image','inspect',tag])).stdout)[0];
    const repo = latest.exec(tag)[1];
    const refs = [...new Set((value?.RepoDigests || []).filter(x => digest.exec(x)?.[1] === repo))];
    if (refs.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(value?.Id || ''))
      throw Error('Latest image has no unambiguous immutable digest');
    const ref = refs[0];
    const pinned = JSON.parse((await run(['docker','image','inspect',ref])).stdout)[0];
    if (pinned?.Id !== value.Id) throw Error('Latest image digest verification failed');
    const current = value.Config?.Labels?.['org.opencontainers.image.revision'];
    if (!/^[a-f0-9]{40}$/.test(current || '') || (revision && revision !== current))
      throw Error('Latest application images do not identify the same release revision');
    revision = current;
    resolved.set(tag,{ref,image:value});
  }
  return {
    revision,
    refs:Object.fromEntries(policy.services.map(s=>[s,resolved.get(policy.imageTags[s]).ref])),
    images:Object.fromEntries(policy.services.map(s=>[s,resolved.get(policy.imageTags[s]).image])),
  };
}
