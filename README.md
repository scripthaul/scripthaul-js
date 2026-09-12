# ScriptHaul for JavaScript

Dependency-free ScriptHaul API client for Node 18.20+ and modern runtimes with `fetch`. MIT licensed.

```sh
npm install scripthaul
```

Until the first npm release, install straight from GitHub: `npm install github:scripthaul/scripthaul-js`. Issues and pull requests are welcome in this repository; the API itself is documented at [api.scripthaul.com/docs](https://api.scripthaul.com/docs).

```js
import ScriptHaul from 'scripthaul';

const client = new ScriptHaul({ apiKey: process.env.SCRIPTHAUL_API_KEY });
const transcript = await client.transcript('dQw4w9WgXcQ');
console.log(transcript.meta.cache, transcript.meta.creditsCharged); // 'HIT' 0
const videos = await client.videos('https://www.youtube.com/@example');
const job = await client.jobs.create({ input: 'https://www.youtube.com/@example' });
await job.wait();
```

## Discovery

Search YouTube or one channel for one credit per delivered page. Identical requests within 60 seconds are free retries. Channel resolution and the latest 15 channel or playlist entries cost zero credits; latest entries come from a feed cached for ten minutes.

```js
const page = await client.search('climate science', { type: 'video', channel: '@TED' });
console.log(page.results, page.meta.creditsCharged); // video results include cached: true/false
if (page.has_more) {
  const next = await client.search('climate science', {
    type: 'video', channel: '@TED', continuation: page.continuation,
  });
}
const channel = await client.channels.resolve('@TED');
const latest = await client.channels.latest({ channel: channel.channel_id });
const playlistLatest = await client.channels.latest({ playlist: channel.uploads_playlist_id });
```

`type` accepts `video` (default), `channel`, or `playlist`. Keep continuation strings unchanged and repeat the same query, type, and channel. Resolve a handle first and pass its `channel_id` to latest uploads so that reading the feed needs no Data API call. `examples/discovery.mjs` requests two search pages, one credit per delivered page.

## Library and monitors

Library coverage and scoped passage search cost zero credits. Fetch any missing transcripts through a normal job first; each successful cold delivery costs one credit and joins the shared library. Search supports quoted phrases and prefix terms and requires one channel or video scope.

Coverage reports `counts.uncaptioned` for known `no_captions` or `unavailable` videos without a searchable index. Those videos are excluded from `missing` and `counts.cold`; an existing index takes precedence. `complete: true` means the source snapshot is complete and nothing indexable is missing, so it can coexist with a positive uncaptioned count. Report that count without promising captions for every video.

```js
const coverage = await client.library.coverage({ channel: '@TED' });
const passages = await client.library.search('"solar energy"', { channel: '@TED', limit: 10, offset: 0 });
console.log(passages.meta.libraryCoverage); // indexed/known, for example "37/412"
const watched = await client.monitors.create({ channel: '@TED', auto_fetch: false });
const monitors = await client.monitors.list();
const monitor = await client.monitors.get(watched.monitor.id);
await client.monitors.cancel(watched.monitor.id);
```

Coverage also accepts `playlist` instead of `channel`; passage search accepts `video_id` instead of `channel`. Monitors accept either `channel` or `playlist`, plus `language`, `fallback`, and `webhook_url`. Set `auto_fetch: true` to authorize ordinary billable transcript jobs for new uploads; monitoring itself costs zero credits. The executable `examples/library.mjs` uses `auto_fetch: false` and cancels its monitor before exiting.

Monitor creation resolves handles on the server through the channel-resolution allowance; direct UC IDs need no resolution call. Each `monitors.create()` generates one idempotency key and reuses it for retries. To recover a creation across separate calls, pass `client.monitors.create(params, { idempotencyKey: 'my-watch-creation' })`. An explicit key must be a nonblank header-safe string of at most 128 characters; invalid keys fail locally. Keys are sent only in the `Idempotency-Key` header. A new watch returns status 201 and `idempotent: false`; replaying a key or creating an already active/paused account source returns 200 and `idempotent: true`, with the existing monitor unchanged. Replaying a key still returns that original monitor after cancellation; use a fresh key for a replacement.

## Response metadata


Every successful body carries a non-enumerable `meta` property with the header contract: `cache` (`HIT`/`MISS`), `creditsCharged`, `creditsBalance`, `rateLimit`, `requestId`, `libraryCoverage`, and `status`. It never appears in `JSON.stringify` or a spread copy. Jobs expose the same object as `job.meta`, refreshed on every read.

## Errors

API failures are subclasses of `ScriptHaulError` named exactly after the server's `errorClass`. Every exception has `errorClass`, `code`, `status`, `retryable`, `retry_after` (seconds, from `Retry-After` or the envelope), `request_id`, `docs_url`, and `details`.

`NotFound` with status 404 and code `feed_not_found` means YouTube returned 404 for a well-formed channel or playlist RSS feed. Latest uploads and monitor creation raise it without automatic retries; check the source ID before trying again.

Failures the server never saw use client-only classes whose `errorClass` is `null`, so a local problem is never mistaken for a relay verdict: `ClientNetworkError` (`code: 'network_error'`, the socket failed), `ClientTimeout` (`poll_timeout` or `job_wait_timeout`, the client's own budget ran out), and `JobPaused` (`job_paused`). All three are `retryable`.

## Retries and polling

POST requests are retried only when they carry a valid `Idempotency-Key`; an unkeyed POST gets one transport attempt even if the connection fails or the response is retryable. Both `jobs.create()` and `monitors.create()` supply stable keys. `job.cancel()` has no key and is not automatically retried.

Retryable requests use `maxRetries` (default three) for network failures, 502, 503, and retryable 429 responses. YouTube and channel search (`GET /v1/search`) share a stricter total limit of **at most one retry**, even when `maxRetries` is higher, because each failed attempt can spend proxy bytes. `maxRetries: 0` disables that retry too. The query and continuation stay unchanged. Other GETs, including library search, retain the configured limit. A response whose envelope says `retryable: false` (every daily cap, and the per-key rpm guard) is raised immediately with `retry_after` preserved; so is one whose `Retry-After` exceeds `maxRetryAfterMs` (default 30 s). Transcript 202 responses are polled along the API's `poll_url` (same origin only) up to `maxPolls` times.

`job.wait()` polls until the job is `completed`, `failed`, or `cancelled`. A `paused` job stops the wait: `InsufficientCredits` (`code: 'job_paused_insufficient_credits'`, with `pause_reason`, `credits`, and `job` in `details`) when the account must buy credits, otherwise `JobPaused`. Pass `waitThroughPauses: true` (per call or on the client) to keep polling instead. `job.cancel()` releases the unsettled reservation.

## Key handling

The key is stored as a non-enumerable property: `console.log(client)`, `util.inspect`, structured loggers, and `JSON.stringify` show only the 12-character display prefix (`client.keyPrefix`). The client sends it solely as `Authorization: Bearer` to `baseUrl`, refuses cross-origin poll URLs, and never follows redirects.
