import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inspect } from 'node:util';

import ScriptHaul, {
  ClientNetworkError, ClientTimeout, InsufficientCredits, InvalidInput, JobPaused,
  QuotaExceeded, RelayUnavailable, SDK_HEADER, ScriptHaulError, VERSION,
} from '../src/index.js';

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('discovery methods encode queries, preserve opaque continuation and expose credit headers', async () => {
  const calls = [];
  const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', fetch: async (input, init) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method });
    return json(200, { ok: true }, { 'x-credits-charged': url.pathname === '/v1/search' ? '1' : '0' });
  } });
  const search = await client.search('science & art', { type: 'video', channel: '@TED', continuation: 'abc_-/+=' });
  assert.equal(search.meta.creditsCharged, 1);
  assert.equal((await client.channels.resolve('https://www.youtube.com/@TED')).meta.creditsCharged, 0);
  await client.channels.latest({ channel: 'UC0123456789abcdefghijkl' });
  await client.channels.latest({ playlist: 'UU0123456789abcdefghijkl' });
  assert.deepEqual(calls, [
    { method: 'GET', path: '/v1/search', query: { q: 'science & art', type: 'video', channel: '@TED', continuation: 'abc_-/+=' } },
    { method: 'GET', path: '/v1/channels/resolve', query: { input: 'https://www.youtube.com/@TED' } },
    { method: 'GET', path: '/v1/channels/latest', query: { channel: 'UC0123456789abcdefghijkl' } },
    { method: 'GET', path: '/v1/channels/latest', query: { playlist: 'UU0123456789abcdefghijkl' } },
  ]);
  assert.throws(() => client.search(''), InvalidInput);
  assert.throws(() => client.channels.resolve(''), InvalidInput);
  assert.throws(() => client.channels.latest(), InvalidInput);
  assert.throws(() => client.channels.latest({ channel: '@TED', playlist: 'UU0123456789abcdefghijkl' }), InvalidInput);
  assert.equal(calls.length, 4, 'invalid local input never reaches the API');
});

test('library scopes stay explicit, coverage headers survive, and monitor ids cannot change routes', async () => {
  const calls = [];
  const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', fetch: async (input, init) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams),
      method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return json(200, { ok: true }, { 'x-library-coverage': '37/412', 'x-credits-charged': '0' });
  } });
  await client.library.coverage({ playlist: 'PLfixture', api_key: 'must-not-be-forwarded' });
  const passages = await client.library.search('"solar energy" renew*', { channel: '@TED', limit: 10, offset: 20 });
  assert.equal(passages.meta.libraryCoverage, '37/412');
  assert.equal(passages.meta.creditsCharged, 0);
  assert.equal(JSON.stringify(passages).includes('37/412'), false);
  await client.monitors.create({ channel: '@TED', auto_fetch: false });
  await client.monitors.list();
  await client.monitors.get('id/with?delimiters');
  await client.monitors.cancel('id/with?delimiters');
  assert.deepEqual(calls, [
    { method: 'GET', path: '/v1/library', query: { playlist: 'PLfixture' }, body: null },
    { method: 'GET', path: '/v1/library/search', query: { q: '"solar energy" renew*', channel: '@TED', limit: '10', offset: '20' }, body: null },
    { method: 'POST', path: '/v1/monitors', query: {}, body: { channel: '@TED', auto_fetch: false } },
    { method: 'GET', path: '/v1/monitors', query: {}, body: null },
    { method: 'GET', path: '/v1/monitors/id%2Fwith%3Fdelimiters', query: {}, body: null },
    { method: 'DELETE', path: '/v1/monitors/id%2Fwith%3Fdelimiters', query: {}, body: null },
  ]);
  for (const operation of [() => client.library.coverage(), () => client.library.search('word'),
    () => client.library.search('word', { channel: '@TED', video_id: 'jNQXAC9IVRw' }),
    () => client.monitors.create(), () => client.monitors.get(''), () => client.monitors.cancel('')]) {
    assert.throws(operation, InvalidInput);
  }
  assert.equal(calls.length, 6);
});

test('monitor creation preserves one generated or supplied idempotency key across network and HTTP retries', async () => {
  for (const supplied of [undefined, null, 'Caller-Monitor_Key:+', 'x'.repeat(128)]) {
    const calls = []; const waits = [];
    const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries: 3,
      retryDelayMs: 0, sleep: async (delay) => waits.push(delay), fetch: async (input, init) => {
        calls.push({ key: new Headers(init.headers).get('idempotency-key'),
          url: new URL(input), body: JSON.parse(init.body) });
        if (calls.length === 1) throw new TypeError('response lost');
        if (calls.length === 2) return json(502, { ok: false, errorClass: 'UpstreamError',
          code: 'temporary', message: 'Try again.', retryable: true }, { 'retry-after': '0' });
        return json(201, { ok: true, monitor: { id: 'monitor-fixture' } });
      } });
    const options = supplied === undefined ? {} : { idempotencyKey: supplied };
    const result = await client.monitors.create({ channel: '@TED', auto_fetch: false }, options);
    assert.equal(result.monitor.id, 'monitor-fixture'); assert.equal(calls.length, 3);
    assert.ok(calls[0].key); assert.equal(new Set(calls.map((call) => call.key)).size, 1);
    if (supplied != null) assert.equal(calls[0].key, supplied);
    assert.deepEqual(waits, [0, 0]);
    for (const call of calls) {
      assert.equal(call.url.search, '');
      assert.deepEqual(call.body, { channel: '@TED', auto_fetch: false });
    }
    await client.monitors.create({ channel: '@TED' });
    assert.notEqual(calls[3].key, calls[0].key, 'a separate creation call gets its own generated key');
  }
});

test('invalid supplied monitor idempotency keys are refused before transport', async () => {
  let calls = 0;
  const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', fetch: async () => {
    calls += 1; return json(201, { ok: true, monitor: { id: 'monitor-fixture' } });
  } });
  for (const idempotencyKey of ['', ' \t ', 'bad\nkey', 'bad\u0000key', 'x'.repeat(129), 0, 42, false, {}, []]) {
    await assert.rejects(async () => client.monitors.create({ channel: '@TED' }, { idempotencyKey }),
      (error) => error instanceof InvalidInput && error.code === 'invalid_idempotency_key');
  }
  assert.equal(calls, 0);
});

test('POST retries require a valid case-insensitive idempotency header for both transport and HTTP failures', async () => {
  for (const failure of ['network', 'http']) {
    for (const headers of [undefined, {}, { 'Idempotency-Key': '' }, { 'IDEMPOTENCY-KEY': '  ' },
      { 'idempotency-key': 'x'.repeat(129) }, { 'Idempotency-Key': 'one', 'idempotency-key': 'two' }]) {
      let calls = 0; const waits = [];
      const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries: 3,
        sleep: async (delay) => waits.push(delay), fetch: async () => {
          calls += 1;
          if (failure === 'network') throw new TypeError('response lost');
          return json(502, { ok: false, errorClass: 'UpstreamError', message: 'Retryable response.', retryable: true });
        } });
      await assert.rejects(client._request('POST', '/v1/jobs/job-fixture/cancel', { headers }), ScriptHaulError);
      assert.equal(calls, 1, `${failure} POST without a valid key is sent once`);
      assert.deepEqual(waits, []);
    }
    let calls = 0;
    const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', retryDelayMs: 0, sleep: async () => {},
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          if (failure === 'network') throw new TypeError('response lost');
          return json(502, { ok: false, errorClass: 'UpstreamError', message: 'Retry.', retryable: true });
        }
        return json(200, { ok: true });
      } });
    await client._request('POST', '/v1/monitors', { headers: { 'iDeMpOtEnCy-KeY': 'case-sensitive-value' }, body: { channel: '@TED' } });
    assert.equal(calls, 2, 'header-name casing cannot disable an otherwise safe retry');
  }
});

test('discovery searches retry network, 429 and 503 failures at most once, preserving query and continuation', async () => {
  for (const maxRetries of [0, 3, 8]) {
    for (const failure of ['network', 429, 503]) {
      const calls = []; const waits = [];
      const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries,
        retryDelayMs: 0, sleep: async (delay) => waits.push(delay), fetch: async (input, init) => {
          calls.push({ url: String(input), method: init.method, body: init.body });
          if (failure === 'network') throw new TypeError('search response lost');
          return json(failure, { ok: false, errorClass: failure === 429 ? 'QuotaExceeded' : 'RelayUnavailable',
            message: 'Try again.', retryable: true, request_id: 'search-final' }, { 'retry-after': '0' });
        } });
      await assert.rejects(client.search('science & art', { type: 'video', channel: '@TED', continuation: 'abc_-/+=' }), (error) => {
        assert.ok(error instanceof ScriptHaulError);
        if (failure === 'network') assert.ok(error instanceof ClientNetworkError);
        else { assert.equal(error.status, failure); assert.equal(error.request_id, 'search-final'); }
        return true;
      });
      const attempts = maxRetries === 0 ? 1 : 2;
      assert.equal(calls.length, attempts, `${failure}, maxRetries=${maxRetries}`);
      assert.deepEqual(waits, Array(attempts - 1).fill(0));
      assert.ok(calls.every((call) => call.url === calls[0].url && call.method === 'GET' && call.body === undefined));
      const url = new URL(calls[0].url);
      assert.equal(url.pathname, '/v1/search');
      assert.deepEqual(Object.fromEntries(url.searchParams), { q: 'science & art', type: 'video', channel: '@TED', continuation: 'abc_-/+=' });
    }
  }
});

test('search uses one shared retry budget across failure kinds and honors final server verdicts', async () => {
  let calls = 0; const waits = [];
  const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries: 8, retryDelayMs: 0,
    sleep: async (delay) => waits.push(delay), fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('search response lost');
      if (calls === 2) return json(503, { errorClass: 'RelayUnavailable', retryable: true,
        message: 'Second attempt failed.', request_id: 'second-attempt' }, { 'retry-after': '0' });
      return json(200, { ok: true, results: [] });
    } });
  await assert.rejects(client.search('mixed failures'), (error) => error instanceof RelayUnavailable && error.request_id === 'second-attempt');
  assert.equal(calls, 2); assert.deepEqual(waits, [0]);
  for (const status of [429, 503]) {
    let finalCalls = 0; const finalWaits = [];
    const final = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries: 8,
      sleep: async (delay) => finalWaits.push(delay), fetch: async () => {
        finalCalls += 1;
        return json(status, { errorClass: status === 429 ? 'QuotaExceeded' : 'RelayUnavailable',
          retryable: false, message: 'Do not retry.', request_id: 'final-verdict' }, { 'retry-after': '0' });
      } });
    await assert.rejects(final.search('final verdict'), (error) => error.retryable === false && error.request_id === 'final-verdict');
    assert.equal(finalCalls, 1); assert.deepEqual(finalWaits, []);
  }
});

test('a single search retry can succeed and other GETs keep their configured retry allowance', async () => {
  let searchCalls = 0;
  const search = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries: 8, sleep: async () => {}, fetch: async () => {
    if (++searchCalls === 1) return json(503, { errorClass: 'RelayUnavailable', retryable: true }, { 'retry-after': '0' });
    return json(200, { ok: true, results: [{ video_id: 'jNQXAC9IVRw' }] }, { 'x-request-id': 'search-replay', 'x-credits-charged': '0' });
  } });
  const page = await search.search('successful retry');
  assert.equal(searchCalls, 2); assert.equal(page.meta.requestId, 'search-replay');
  assert.equal(page.meta.creditsCharged, 0); assert.equal(page.results[0].video_id, 'jNQXAC9IVRw');
  for (const kind of ['library', 'listing']) {
    const paths = []; const waits = [];
    const client = new ScriptHaul({ apiKey: 'sh_test_unit_fixture', maxRetries: 3,
      sleep: async (delay) => waits.push(delay), fetch: async (url) => {
        paths.push(new URL(url).pathname);
        return json(503, { errorClass: 'RelayUnavailable', retryable: true }, { 'retry-after': '0' });
      } });
    await assert.rejects(kind === 'library' ? client.library.search('energy', { video_id: 'jNQXAC9IVRw' }) : client.videos('@TED'), RelayUnavailable);
    assert.deepEqual(paths, Array(4).fill(kind === 'library' ? '/v1/library/search' : '/v1/videos'));
    assert.deepEqual(waits, [0, 0, 0]);
  }
});

test('retries a retryable 429 within the configured bound', async () => {
  let calls = 0;
  const waits = [];
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture',
    retryDelayMs: 0,
    sleep: async (delay) => { waits.push(delay); },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return json(429, {
        ok: false, errorClass: 'RateLimited', code: 'edge_rate_limit',
        message: 'Slow down.', retryable: true, request_id: 'req-429',
      }, { 'retry-after': '0' });
      return json(200, { ok: true, videos: [] });
    },
  });
  assert.deepEqual(await client.videos('https://youtube.com/@fixture'), {
    ok: true, videos: [],
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
});

test('does not retry a 429 the server marked final, and keeps retry_after', async () => {
  let calls = 0;
  const waits = [];
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture',
    retryDelayMs: 0,
    sleep: async (delay) => { waits.push(delay); },
    fetch: async () => {
      calls += 1;
      return json(429, {
        ok: false, errorClass: 'QuotaExceeded', code: 'cold_fetch_cap',
        message: 'This key reached its daily cold-fetch cap.', retryable: false,
        retry_after: 86_400, request_id: 'req-cap',
      }, { 'retry-after': '86400' });
    },
  });
  await assert.rejects(client.videos('https://youtube.com/@fixture'), (error) => {
    assert.ok(error instanceof QuotaExceeded);
    assert.equal(error.code, 'cold_fetch_cap');
    assert.equal(error.retryable, false);
    assert.equal(error.retry_after, 86_400);
    assert.equal(error.request_id, 'req-cap');
    return true;
  });
  assert.equal(calls, 1, 'a final verdict is not retried');
  assert.deepEqual(waits, [], 'and the caller is never put to sleep');
});

test('does not sleep through a Retry-After longer than maxRetryAfterMs', async () => {
  let calls = 0;
  const waits = [];
  const fetch = async () => {
    calls += 1;
    if (calls === 1) return json(503, {
      ok: false, errorClass: 'RelayUnavailable', code: 'relay_down',
      message: 'Back soon.', retryable: true, request_id: 'req-long',
    }, { 'retry-after': '3600' });
    return json(200, { ok: true, videos: [] });
  };
  const strict = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', retryDelayMs: 0, fetch,
    sleep: async (delay) => { waits.push(delay); },
  });
  await assert.rejects(strict.videos('https://youtube.com/@fixture'), (error) => (
    error instanceof RelayUnavailable && error.retry_after === 3600 && error.retryable === true
  ));
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);

  calls = 0;
  const patient = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', retryDelayMs: 0, fetch, maxRetryAfterMs: 7_200_000,
    sleep: async (delay) => { waits.push(delay); },
  });
  assert.deepEqual(await patient.videos('https://youtube.com/@fixture'), { ok: true, videos: [] });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3_600_000], 'an opt-in ceiling honours the hint');
});

test('never forwards credential-like options in the query string', async () => {
  let requested;
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture',
    fetch: async (url) => {
      requested = new URL(url);
      return json(200, { ok: true, video: { id: 'dQw4w9WgXcQ' } });
    },
  });
  await client.transcript('dQw4w9WgXcQ', { api_key: 'fixture-only', format: 'clean' });
  assert.equal(requested.searchParams.get('format'), 'clean');
  assert.equal(requested.searchParams.has('api_key'), false);
});

test('raises the exact server error type with request_id', async () => {
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture',
    fetch: async () => json(402, {
      ok: false, errorClass: 'InsufficientCredits', code: 'shortfall',
      message: 'Buy more credits.', retryable: false,
      docs_url: 'https://api.scripthaul.com/docs/credits-limits',
      request_id: 'req-credit-test', shortfall: 2,
    }),
  });
  await assert.rejects(client.transcript('badcredits1'), (error) => {
    assert.ok(error instanceof InsufficientCredits);
    assert.equal(error.errorClass, 'InsufficientCredits');
    assert.equal(error.request_id, 'req-credit-test');
    assert.equal(error.details.shortfall, 2);
    return true;
  });
});

test('exposes the credit, cache, rate-limit, and request-id headers as non-enumerable meta', async () => {
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture',
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/v1/transcript') {
        return json(200, { ok: true, video: { id: 'dQw4w9WgXcQ' }, text: 'Fixture' }, {
          'x-cache': 'HIT', 'x-credits-charged': '0', 'x-credits-balance': '99',
          'x-ratelimit-limit': '60', 'x-request-id': 'req-meta-1',
        });
      }
      if (path === '/v1/jobs') {
        return json(202, { ok: true, job: { id: '0123456789abcdef0123456789abcdef', status: 'pending' } }, {
          'x-credits-balance': '97', 'x-request-id': 'req-meta-2',
        });
      }
      return json(200, { ok: true, job: { id: '0123456789abcdef0123456789abcdef', status: 'completed' } }, {
        'x-credits-balance': '96', 'x-request-id': 'req-meta-3',
      });
    },
  });
  const transcript = await client.transcript('dQw4w9WgXcQ');
  assert.deepEqual(transcript.meta, {
    status: 200, cache: 'HIT', creditsCharged: 0, creditsBalance: 99, rateLimit: 60, requestId: 'req-meta-1', libraryCoverage: null,
  });
  assert.deepEqual(Object.keys(transcript), ['ok', 'video', 'text'], 'meta is not enumerable');
  assert.equal(JSON.stringify(transcript).includes('meta'), false);

  const job = await client.jobs.create({ input: 'https://youtube.com/@fixture' });
  assert.equal(job.meta.requestId, 'req-meta-2');
  assert.equal(job.meta.creditsBalance, 97);
  assert.equal(job.meta.cache, null, 'absent headers read as null');
  await job.refresh();
  assert.equal(job.meta.requestId, 'req-meta-3');
  assert.equal(JSON.stringify(job).includes('meta'), false);
});

test('Job.wait() stops on a paused job instead of polling it for ten minutes', async () => {
  const jobBody = (status, extra = {}) => json(200, {
    ok: true, job: {
      id: '0123456789abcdef0123456789abcdef', status, counts: { total: 3, completed: 1 },
      credits: { reserved: 2, charged: 1, released: 0, outstanding: 1 }, ...extra,
    },
  }, { 'x-request-id': `req-${status}` });
  const paused = (reason) => new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', jobPollIntervalMs: 0, sleep: async () => {},
    fetch: async (_url, init) => (init.method === 'POST'
      ? json(202, { ok: true, job: { id: '0123456789abcdef0123456789abcdef', status: 'pending' } })
      : jobBody('paused', { pause_reason: reason })),
  });

  const short = await paused('insufficient_credits').jobs.create({ input: 'https://youtube.com/@fixture' });
  await assert.rejects(short.wait(), (error) => {
    assert.ok(error instanceof InsufficientCredits);
    assert.equal(error.code, 'job_paused_insufficient_credits');
    assert.equal(error.details.pause_reason, 'insufficient_credits');
    assert.deepEqual(error.details.credits, { reserved: 2, charged: 1, released: 0, outstanding: 1 });
    assert.equal(error.job, short);
    assert.equal(error.request_id, 'req-paused');
    return true;
  });

  const outage = await paused('proxy_budget').jobs.create({ input: 'https://youtube.com/@fixture' });
  await assert.rejects(outage.wait(), (error) => {
    assert.ok(error instanceof JobPaused);
    assert.equal(error.errorClass, null, 'a pause is not a server error verdict');
    assert.equal(error.code, 'job_paused');
    assert.equal(error.retryable, true);
    assert.equal(error.details.pause_reason, 'proxy_budget');
    return true;
  });

  let reads = 0;
  const resumed = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', jobPollIntervalMs: 0, sleep: async () => {},
    fetch: async (_url, init) => {
      if (init.method === 'POST') return json(202, { ok: true, job: { id: '0123456789abcdef0123456789abcdef', status: 'pending' } });
      reads += 1;
      return reads < 3 ? jobBody('paused', { pause_reason: 'insufficient_credits' }) : jobBody('completed');
    },
  });
  const job = await resumed.jobs.create({ input: 'https://youtube.com/@fixture' });
  await job.wait({ waitThroughPauses: true });
  assert.equal(job.status, 'completed');
  assert.equal(reads, 3, 'opt-in waiting polls through the pause');
});

test('does not send a key to a cross-origin 202 poll URL', async () => {
  let calls = 0;
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', pollIntervalMs: 0,
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      return json(202, {
        ok: true, request_id: 'req-poll', poll_url: 'https://evil.example/poll',
      });
    },
  });
  await assert.rejects(client.transcript('dQw4w9WgXcQ'), (error) => (
    error instanceof InvalidInput && error.code === 'unsafe_poll_url'
  ));
  assert.equal(calls, 1);
});

test('uses manual redirect handling so fetch cannot forward the key', async () => {
  let calls = 0;
  const client = new ScriptHaul({
    apiKey: 'sh_test_redirect_fixture', maxRetries: 0,
    fetch: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return new Response(null, {
        status: 302, headers: { location: 'https://evil.example/leak' },
      });
    },
  });
  await assert.rejects(client.videos('https://youtube.com/@fixture'), ScriptHaulError);
  assert.equal(calls, 1);
});

test('stops after the configured retry count', async () => {
  let calls = 0;
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', maxRetries: 2, retryDelayMs: 0,
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      return json(503, {
        ok: false, errorClass: 'RelayUnavailable', code: 'relay_down',
        message: 'Still unavailable.', retryable: true, request_id: 'req-final',
      }, { 'retry-after': '0' });
    },
  });
  await assert.rejects(client.videos('https://youtube.com/@fixture'), (error) => (
    error instanceof RelayUnavailable && error.request_id === 'req-final'
  ));
  assert.equal(calls, 3);
});

test('client-side failures use client-only classes, never a server errorClass', async () => {
  const offline = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', maxRetries: 1, retryDelayMs: 0, sleep: async () => {},
    fetch: async () => { throw new TypeError('fetch failed: ENOTFOUND'); },
  });
  await assert.rejects(offline.videos('https://youtube.com/@fixture'), (error) => {
    assert.ok(error instanceof ClientNetworkError);
    assert.ok(error instanceof ScriptHaulError);
    assert.ok(!(error instanceof RelayUnavailable));
    assert.equal(error.errorClass, null);
    assert.equal(error.code, 'network_error');
    assert.equal(error.retryable, true);
    assert.match(error.details.cause, /ENOTFOUND/);
    return true;
  });

  const stuck = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', jobPollIntervalMs: 0, jobTimeoutMs: 0, sleep: async () => {},
    fetch: async () => json(200, { ok: true, job: { id: '0123456789abcdef0123456789abcdef', status: 'running' } }),
  });
  const job = await stuck.jobs.create({ input: 'https://youtube.com/@fixture' });
  await assert.rejects(job.wait(), (error) => (
    error instanceof ClientTimeout && error.errorClass === null && error.code === 'job_wait_timeout'
  ));
});

test('stops 202 polling at the configured bound with a client timeout', async () => {
  let calls = 0;
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture', maxPolls: 1, pollIntervalMs: 0,
    sleep: async () => {},
    fetch: async () => {
      calls += 1;
      return json(202, {
        ok: true, request_id: 'req-poll-bound',
        poll_url: '/v1/transcript?request_id=req-poll-bound',
      }, { 'retry-after': '0' });
    },
  });
  await assert.rejects(client.transcript('dQw4w9WgXcQ'), (error) => (
    error instanceof ClientTimeout
      && error.errorClass === null
      && error.code === 'poll_timeout'
      && error.request_id === 'req-poll-bound'
  ));
  assert.equal(calls, 2);
});

test('the telemetry header is derived from package.json', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, packageJson.version);
  assert.equal(SDK_HEADER, `javascript/${packageJson.version}`);
  let sent;
  const client = new ScriptHaul({
    apiKey: 'sh_test_unit_fixture',
    fetch: async (_url, init) => { sent = init.headers; return json(200, { ok: true, videos: [] }); },
  });
  await client.videos('https://youtube.com/@fixture');
  assert.equal(sent['x-scripthaul-sdk'], SDK_HEADER);
});

test('the API key is hidden from enumeration, inspection, and JSON', () => {
  const key = 'sh_test_unit_fixture_secret_value_0123456789';
  const client = new ScriptHaul({ apiKey: key, fetch: async () => json(200, {}) });
  assert.equal(client.apiKey, key, 'the client itself can still read the key');
  assert.equal(Object.keys(client).includes('apiKey'), false);
  assert.equal(inspect(client).includes(key), false);
  assert.match(inspect(client), /sh_test_unit\.\.\./);
  assert.equal(Object.getOwnPropertyDescriptor(client, 'apiKey').enumerable, false);
  const serialized = JSON.stringify(client, (name, value) => (name === 'jobs' ? undefined : value));
  assert.equal(serialized.includes(key), false);
  assert.equal(client.keyPrefix, key.slice(0, 12));
});
