// Register before mutation handlers. A direct API call must obey the same policy as the buttons.
export function registerDeploymentGuards(app, dependencies) {
  const { requireAuth, inspect, composeInfo, selfName, ensurePlain, ensureIdle, ensureNoRuns } =
    dependencies;
  const guard = (check) => async (req, res, next) => {
    try {
      await check(req);
      next();
    } catch (error) {
      res.status(409).json({ error: error.message });
    }
  };
  const container = (updating) => async (req) => {
    const info = await inspect(req.params.id);
    if ((info.Name || '').replace(/^\//, '') === selfName) {
      await ensureNoRuns();
      return;
    }
    const project = composeInfo(info.Config?.Labels || {});
    if (!project) return;
    await (updating ? ensurePlain : ensureIdle)(project.project);
  };
  app.post('/api/containers/:id/update', requireAuth, guard(container(true)));
  app.post(
    '/api/containers/:id/:action',
    requireAuth,
    guard(async (req) => {
      if (['start', 'stop', 'restart'].includes(req.params.action)) await container(false)(req);
    }),
  );
  app.post('/api/system/prune/:target', requireAuth, guard(ensureNoRuns));
  app.post('/api/system/volumes/remove', requireAuth, guard(ensureNoRuns));
}
