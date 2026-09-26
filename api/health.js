/**
 * Liveness check for the opt-in pipeline. Point a Vercel cron or an uptime
 * monitor at this and alert on a non-200, otherwise a 500ing function is only
 * discovered when a lead complains.
 *
 * The checks themselves live in _health-checks.js so this endpoint and the
 * cron watcher that emails you can never disagree about what "healthy" is.
 */

const { runChecks } = require('./_health-checks.js');

module.exports = async function handler(req, res) {
  const result = await runChecks();

  res.setHeader('Cache-Control', 'no-store');
  return res.status(result.ok ? 200 : 503).json({ ...result, at: new Date().toISOString() });
};
