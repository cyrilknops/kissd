import { parseHistoryQuery } from './metrics-store.js';

export function registerMetricsRoutes(app, { requireAuth, history }) {
  app.get('/api/metrics', requireAuth, (req, res) => {
    let query;
    try { query = parseHistoryQuery(req.query); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(history(query));
    } catch (err) {
      console.error(`metrics history failed: ${err.message}`);
      res.status(503).json({ error: 'Metrics history is temporarily unavailable' });
    }
  });
}
