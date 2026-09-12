import ScriptHaul from '../src/index.js';

const client = new ScriptHaul();
const channel = process.env.SCRIPTHAUL_CHANNEL || '@TED';
const query = process.env.SCRIPTHAUL_QUERY || '"solar energy"';
const coverage = await client.library.coverage({ channel });
const passages = await client.library.search(query, { channel, limit: 10 });
const created = await client.monitors.create({ channel, auto_fetch: false });
let listed;
let current;
let cancelled;
try {
  listed = await client.monitors.list();
  current = await client.monitors.get(created.monitor.id);
} finally {
  cancelled = await client.monitors.cancel(created.monitor.id);
}
console.log(JSON.stringify({ complete: coverage.complete, indexed: coverage.indexed,
  passages: passages.results, coverage: passages.meta.libraryCoverage,
  monitor_listed: listed.monitors.some((monitor) => monitor.id === created.monitor.id),
  monitor_status: current.monitor.status, cancelled: cancelled.cancelled,
  credits_charged: coverage.meta.creditsCharged + passages.meta.creditsCharged + created.meta.creditsCharged }));
