import ScriptHaul from 'scripthaul';

const client = new ScriptHaul({
  apiKey: process.env.SCRIPTHAUL_API_KEY,
  baseUrl: process.env.SCRIPTHAUL_BASE_URL,
  pollIntervalMs: Number(process.env.SCRIPTHAUL_POLL_MS || 1000),
  jobPollIntervalMs: Number(process.env.SCRIPTHAUL_POLL_MS || 2000),
  jobTimeoutMs: Number(process.env.SCRIPTHAUL_JOB_TIMEOUT_MS || 600_000),
});
const videoId = process.env.SCRIPTHAUL_VIDEO_ID || 'dQw4w9WgXcQ';
const input = process.env.SCRIPTHAUL_INPUT;
if (!input) throw new Error('Set SCRIPTHAUL_INPUT to a public YouTube channel or playlist URL.');
// Spend bound for live runs: pin the job to listed videos (they must belong
// to SCRIPTHAUL_INPUT) and refuse to wait on a job larger than the cap.
const jobVideoIds = (process.env.SCRIPTHAUL_JOB_VIDEO_IDS || '').split(',')
  .map((value) => value.trim()).filter(Boolean);
const maxJobVideos = Number(process.env.SCRIPTHAUL_MAX_JOB_VIDEOS || 5);

const transcript = await client.transcript(videoId, { format: 'clean' });
const listing = await client.videos(input, { contents: 'videos' });
const job = await client.jobs.create({
  input,
  format: 'clean',
  ...(jobVideoIds.length ? { video_ids: jobVideoIds } : {}),
}, { idempotencyKey: process.env.SCRIPTHAUL_IDEMPOTENCY_KEY || undefined });
const total = job.data.counts?.total ?? 0;
if (total > maxJobVideos) {
  await job.cancel();
  throw new Error(`Job ${job.id} spans ${total} videos; the quickstart bound is ${maxJobVideos}. Set SCRIPTHAUL_JOB_VIDEO_IDS.`);
}
await job.wait();
if (job.status !== 'completed') throw new Error(`Job ${job.id} ended as ${job.status}.`);

console.log(JSON.stringify({
  transcript: transcript.video.id,
  cache: transcript.meta.cache,
  videos: listing.videos.length,
  job: job.id,
  status: job.status,
}));
