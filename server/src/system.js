// Disk usage and pruning.
//
// Deliberately NOT offering a blanket `docker volume prune`: a named volume
// counts as "dangling" whenever its container merely isn't running, so a bulk
// prune silently destroys real data (on this host it would have taken out
// mail-iwg-it_mongodb_data). Volumes are listed by name and removed one at a
// time, with the caller naming the exact volume.
import { docker } from './docker.js';

export async function usage() {
  const df = await docker.df();

  const images = df.Images || [];
  const containers = df.Containers || [];
  const volumes = df.Volumes || [];
  const cache = df.BuildCache || [];

  const sum = (arr, pick) => arr.reduce((a, x) => a + (pick(x) || 0), 0);

  // An image with no containers referencing it is what `image prune -a` takes.
  const unusedImages = images.filter((i) => !i.Containers || i.Containers <= 0);
  const danglingImages = images.filter((i) => !i.RepoTags || i.RepoTags.length === 0
    || i.RepoTags[0] === '<none>:<none>');
  const stoppedContainers = containers.filter((c) => c.State !== 'running');
  const unusedVolumes = volumes.filter((v) => (v.UsageData?.RefCount ?? 0) <= 0);
  const unusedCache = cache.filter((c) => !c.InUse);

  // Sizes here are what a prune would actually free, which is deliberately not
  // what `docker system df` prints in its RECLAIMABLE column. On this host the
  // CLI claims ~25.5GB reclaimable out of 33.7GB while 21 of 28 images are in
  // active use — it reports total-minus-unused rather than the unused images'
  // own footprint. We report the honest figure: the unique size of the images a
  // prune would remove. Subtracting SharedSize avoids counting a layer twice
  // when several unused images share it.
  const uniqueSize = (i) => Math.max(0, i.Size - Math.max(0, i.SharedSize || 0));
  const layersSize = df.LayersSize || sum(images, (i) => i.Size);

  return {
    images: {
      total: images.length,
      size: layersSize,
      reclaimable: sum(unusedImages, uniqueSize),
      unusedCount: unusedImages.length,
      danglingCount: danglingImages.length,
      danglingSize: sum(danglingImages, uniqueSize),
    },
    containers: {
      total: containers.length,
      size: sum(containers, (c) => c.SizeRw),
      reclaimable: sum(stoppedContainers, (c) => c.SizeRw),
      stoppedCount: stoppedContainers.length,
    },
    buildCache: {
      total: cache.length,
      size: sum(cache, (c) => c.Size),
      // Shared cache records are counted under another record too; including
      // them here would double the figure (1.57GB instead of the real 717MB).
      reclaimable: sum(unusedCache.filter((c) => !c.Shared), (c) => c.Size),
      unusedCount: unusedCache.filter((c) => !c.Shared).length,
    },
    // Full detail, because the user has to make the call per volume.
    volumes: {
      total: volumes.length,
      size: sum(volumes, (v) => v.UsageData?.Size),
      unused: unusedVolumes.map((v) => ({
        name: v.Name,
        size: v.UsageData?.Size ?? 0,
        driver: v.Driver,
        createdAt: v.CreatedAt || null,
        // Compose-created volumes carry their project, which is the strongest
        // hint that a volume holds real application data.
        project: v.Labels?.['com.docker.compose.project'] || null,
      })).sort((a, b) => b.size - a.size),
    },
    at: Date.now(),
  };
}

const PRUNERS = {
  'images-dangling': {
    label: 'dangling images',
    run: () => docker.pruneImages({ filters: JSON.stringify({ dangling: { true: true } }) }),
    reclaimed: (r) => r.SpaceReclaimed,
    removed: (r) => (r.ImagesDeleted || []).length,
  },
  'images-unused': {
    label: 'all unused images',
    run: () => docker.pruneImages({ filters: JSON.stringify({ dangling: { false: true } }) }),
    reclaimed: (r) => r.SpaceReclaimed,
    removed: (r) => (r.ImagesDeleted || []).length,
  },
  containers: {
    label: 'stopped containers',
    run: () => docker.pruneContainers(),
    reclaimed: (r) => r.SpaceReclaimed,
    removed: (r) => (r.ContainersDeleted || []).length,
  },
  networks: {
    label: 'unused networks',
    run: () => docker.pruneNetworks(),
    reclaimed: () => 0,
    removed: (r) => (r.NetworksDeleted || []).length,
  },
  build: {
    label: 'build cache',
    run: () => docker.pruneBuilder(),
    reclaimed: (r) => r.SpaceReclaimed,
    removed: (r) => (r.CachesDeleted || []).length,
  },
};

export const PRUNE_TARGETS = Object.keys(PRUNERS);

export async function prune(target) {
  const pruner = PRUNERS[target];
  if (!pruner) throw new Error(`Unknown prune target: ${target}`);
  const result = await pruner.run();
  return {
    target,
    label: pruner.label,
    spaceReclaimed: pruner.reclaimed(result) || 0,
    removed: pruner.removed(result) || 0,
  };
}

export async function removeVolume(name) {
  const volume = docker.getVolume(name);
  // Re-check refcount at the moment of deletion, so a volume that got attached
  // between listing and clicking can't be removed out from under a container.
  const df = await docker.df();
  const found = (df.Volumes || []).find((v) => v.Name === name);
  if (!found) throw new Error(`Volume ${name} no longer exists`);
  if ((found.UsageData?.RefCount ?? 0) > 0) {
    throw new Error(`Volume ${name} is now in use by a container — refusing to remove it`);
  }
  await volume.remove();
  return { name, size: found.UsageData?.Size ?? 0 };
}
