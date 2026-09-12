import packageJson from '../package.json' with { type: 'json' };

const DEFAULT_BASE_URL = 'https://api.scripthaul.com';
const RETRY_STATUSES = new Set([429, 502, 503]);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// Polls are bounded separately from retries: a 202 Retry-After is the server's
// pacing hint, never a reason to give up.
const MAX_POLL_DELAY_MS = 30_000;

// The telemetry header and the published version share one source, so a
// release bump cannot lie to server-side telemetry or break a test elsewhere.
export const VERSION = packageJson.version;
export const SDK_HEADER = `javascript/${VERSION}`;

export class ScriptHaulError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    // Server classes pin their errorClass statically. Client-only classes pin
    // null, so a local socket failure or an undersized timeout can never be
    // mistaken for a relay verdict: the taxonomy is load-bearing across
    // relay, Worker, and client.
    const fallback = this.constructor.errorClass === undefined
      ? 'UpstreamError' : this.constructor.errorClass;
    this.errorClass = options.errorClass === undefined ? fallback : options.errorClass;
    this.code = options.code || 'unexpected_error';
    this.status = options.status ?? null;
    this.retryable = Boolean(options.retryable);
    this.retry_after = Number.isFinite(options.retry_after) ? options.retry_after : null;
    this.request_id = options.request_id || null;
    this.docs_url = options.docs_url || null;
    this.details = options.details || {};
  }
}

export class IpBlocked extends ScriptHaulError { static errorClass = 'IpBlocked'; }
export class PoTokenRequired extends ScriptHaulError { static errorClass = 'PoTokenRequired'; }
export class RateLimited extends ScriptHaulError { static errorClass = 'RateLimited'; }
export class Unavailable extends ScriptHaulError { static errorClass = 'Unavailable'; }
export class NoCaptions extends ScriptHaulError { static errorClass = 'NoCaptions'; }
export class UpstreamError extends ScriptHaulError { static errorClass = 'UpstreamError'; }
export class RelayUnavailable extends ScriptHaulError { static errorClass = 'RelayUnavailable'; }
export class BudgetExhausted extends ScriptHaulError { static errorClass = 'BudgetExhausted'; }
export class InvalidInput extends ScriptHaulError { static errorClass = 'InvalidInput'; }
export class NotFound extends ScriptHaulError { static errorClass = 'NotFound'; }
export class QuotaExceeded extends ScriptHaulError { static errorClass = 'QuotaExceeded'; }
export class TurnstileFailed extends ScriptHaulError { static errorClass = 'TurnstileFailed'; }
export class Forbidden extends ScriptHaulError { static errorClass = 'Forbidden'; }
export class InsufficientCredits extends ScriptHaulError { static errorClass = 'InsufficientCredits'; }
export class AccountFrozen extends ScriptHaulError { static errorClass = 'AccountFrozen'; }
export class ConfigurationError extends ScriptHaulError { static errorClass = 'ConfigurationError'; }

// Client-only failures. They never carry a server errorClass because no
// server verdict exists: the request did not complete, or the caller's own
// budget ran out first. All three are retryable by construction.
export class ClientNetworkError extends ScriptHaulError { static errorClass = null; }
export class ClientTimeout extends ScriptHaulError { static errorClass = null; }
export class JobPaused extends ScriptHaulError { static errorClass = null; }

export const errorClasses = Object.freeze({
  IpBlocked, PoTokenRequired, RateLimited, Unavailable, NoCaptions,
  UpstreamError, RelayUnavailable, BudgetExhausted, InvalidInput, NotFound,
  QuotaExceeded, TurnstileFailed, Forbidden, InsufficientCredits,
  AccountFrozen, ConfigurationError,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-After from the header (seconds or HTTP-date), else the envelope's
// retry_after; null when the server gave no hint at all.
function retryAfterMs(response, payload) {
  const value = response.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const bodySeconds = Number(payload?.retry_after);
  if (payload && typeof payload === 'object' && Number.isFinite(bodySeconds)) {
    return Math.max(0, bodySeconds * 1000);
  }
  return null;
}

function pollDelay(response, fallbackMs) {
  const hinted = retryAfterMs(response, null);
  return Math.min(MAX_POLL_DELAY_MS, hinted ?? fallbackMs);
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    query.set(key, typeof value === 'boolean' ? String(value) : value);
  }
  return query.toString();
}

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sdk-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function validIdempotencyKey(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
    && !/[\x00-\x08\x0a-\x1f\x7f\u0100-\uffff]/.test(value);
}

function monitorIdempotencyKey(value) {
  if (value == null) return idempotencyKey();
  if (!validIdempotencyKey(value)) throw new InvalidInput('Idempotency-Key must contain 1 to 128 header-safe characters.', {
    code: 'invalid_idempotency_key',
  });
  return value;
}

function hasIdempotencyKey(headers) {
  const values = Object.entries(headers || {})
    .filter(([name]) => name.toLowerCase() === 'idempotency-key').map(([, value]) => value);
  // Conflicting differently-cased headers must not turn a mutation into a
  // retryable request; the server receives only one stable replay identity.
  return values.length === 1 && validIdempotencyKey(values[0]);
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function headerNumber(response, name) {
  const value = response.headers.get(name);
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// The headers are the contract API-SPEC §6 sells ("credit headers on every
// response"); the SDK must not be the place where they disappear.
function responseMeta(response) {
  return Object.freeze({
    status: response.status,
    cache: response.headers.get('x-cache') || null,
    creditsCharged: headerNumber(response, 'x-credits-charged'),
    creditsBalance: headerNumber(response, 'x-credits-balance'),
    rateLimit: headerNumber(response, 'x-ratelimit-limit'),
    requestId: response.headers.get('x-request-id') || null,
    libraryCoverage: response.headers.get('x-library-coverage') || null,
  });
}

// Non-enumerable so `meta` never leaks into JSON.stringify, deep-equality, or
// a spread copy of a response body.
function attachMeta(target, meta) {
  if (target && typeof target === 'object' && meta) {
    Object.defineProperty(target, 'meta', { value: meta, enumerable: false, configurable: true });
  }
  return target;
}

function apiError(response, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const errorClass = body.errorClass || 'UpstreamError';
  const ErrorType = errorClasses[errorClass] || ScriptHaulError;
  const hinted = retryAfterMs(response, body);
  return new ErrorType(body.message || `ScriptHaul returned HTTP ${response.status}.`, {
    errorClass,
    code: body.code,
    status: response.status,
    retryable: body.retryable,
    retry_after: hinted == null ? null : Math.ceil(hinted / 1000),
    request_id: body.request_id || response.headers.get('x-request-id'),
    docs_url: body.docs_url,
    details: body,
  });
}

function pausedError(job) {
  const reason = job.data.pause_reason || null;
  const details = { pause_reason: reason, credits: job.data.credits ?? null, job: job.data };
  const error = reason === 'insufficient_credits'
    ? new InsufficientCredits(
      `Job ${job.id} is paused until the account buys credits (pause_reason insufficient_credits).`,
      { code: 'job_paused_insufficient_credits', retryable: false, details, request_id: job.meta?.requestId },
    )
    : new JobPaused(
      `Job ${job.id} is paused (${reason || 'reason not given'}); pass waitThroughPauses to keep polling.`,
      { code: 'job_paused', retryable: true, details, request_id: job.meta?.requestId },
    );
  error.job = job;
  return error;
}

export class Job {
  constructor(client, data, meta = null) {
    if (!data?.id) throw new InvalidInput('The API returned a job without an id.', {
      code: 'invalid_job_response',
    });
    this._client = client;
    this.data = attachMeta(data, meta ?? data?.meta ?? null);
  }

  get id() { return this.data.id; }
  get status() { return this.data.status; }
  get meta() { return this.data.meta ?? null; }

  async refresh() {
    const payload = await this._client._request('GET', `/v1/jobs/${encodeURIComponent(this.id)}`);
    this.data = attachMeta(payload.job || payload, payload.meta ?? null);
    return this;
  }

  // Cancel releases the unsettled reservation; already-delivered rows keep
  // their charge. The API answers with the job when it can, else re-read it.
  async cancel() {
    const payload = await this._client._request('POST', `/v1/jobs/${encodeURIComponent(this.id)}/cancel`);
    if (payload?.job?.id) {
      this.data = attachMeta(payload.job, payload.meta ?? null);
      return this;
    }
    return this.refresh();
  }

  async wait(options = {}) {
    const interval = options.pollIntervalMs ?? this._client.jobPollIntervalMs;
    const timeout = options.timeoutMs ?? this._client.jobTimeoutMs;
    const waitThroughPauses = options.waitThroughPauses ?? this._client.waitThroughPauses;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (TERMINAL_JOB_STATUSES.has(this.status)) return this;
      // A paused job waits for a purchase or the cron, not for this loop:
      // polling it every two seconds for ten minutes is ~300 metered reads
      // that cannot change the outcome.
      if (this.status === 'paused' && !waitThroughPauses) throw pausedError(this);
      if (Date.now() >= deadline) {
        throw new ClientTimeout(`Timed out waiting for job ${this.id}.`, {
          code: 'job_wait_timeout', retryable: true, request_id: this.meta?.requestId,
        });
      }
      if (interval > 0) await this._client._sleep(interval);
      await this.refresh();
    }
  }

  toJSON() { return this.data; }
}

class Jobs {
  constructor(client) { this._client = client; }

  async create(params, options = {}) {
    if (!params || typeof params !== 'object' || !params.input) {
      throw new InvalidInput('jobs.create() requires an input.', { code: 'missing_job_input' });
    }
    const headers = {
      'idempotency-key': options.idempotencyKey || idempotencyKey(),
    };
    const payload = await this._client._request('POST', '/v1/jobs', {
      headers, body: params,
    });
    return new Job(this._client, payload.job || payload, payload.meta ?? null);
  }
}

class Channels {
  constructor(client) { Object.defineProperty(this, '_client', { value: client }); }

  resolve(input) {
    if (!input) throw new InvalidInput('channels.resolve() requires a channel input.', {
      code: 'missing_channel_input',
    });
    return this._client._request('GET', `/v1/channels/resolve?${queryString({ input })}`);
  }

  latest(options = {}) {
    if (!options || Boolean(options.channel) === Boolean(options.playlist)) {
      throw new InvalidInput('channels.latest() requires exactly one channel or playlist.', {
        code: 'invalid_latest_scope',
      });
    }
    return this._client._request('GET', `/v1/channels/latest?${queryString({
      channel: options.channel, playlist: options.playlist,
    })}`);
  }
}

class Library {
  constructor(client) { Object.defineProperty(this, '_client', { value: client }); }

  coverage(options = {}) {
    if (!options || Boolean(options.channel) === Boolean(options.playlist)) {
      throw new InvalidInput('library.coverage() requires exactly one channel or playlist.', {
        code: 'invalid_library_scope',
      });
    }
    return this._client._request('GET', `/v1/library?${queryString({
      channel: options.channel, playlist: options.playlist,
    })}`);
  }

  search(query, options = {}) {
    if (!query || !options || Boolean(options.channel) === Boolean(options.video_id)) {
      throw new InvalidInput('library.search() requires a query and exactly one channel or video_id.', {
        code: 'invalid_library_search',
      });
    }
    return this._client._request('GET', `/v1/library/search?${queryString({
      q: query, channel: options.channel, video_id: options.video_id,
      limit: options.limit, offset: options.offset,
    })}`);
  }
}

class Monitors {
  constructor(client) { Object.defineProperty(this, '_client', { value: client }); }

  create(params = {}, options = {}) {
    if (!params || Boolean(params.channel) === Boolean(params.playlist)) {
      throw new InvalidInput('monitors.create() requires exactly one channel or playlist.', {
        code: 'invalid_monitor_scope',
      });
    }
    const key = monitorIdempotencyKey(options?.idempotencyKey);
    return this._client._request('POST', '/v1/monitors', {
      headers: { 'idempotency-key': key }, body: {
        channel: params.channel, playlist: params.playlist, auto_fetch: params.auto_fetch,
        language: params.language, fallback: params.fallback, webhook_url: params.webhook_url,
      },
    });
  }

  list() { return this._client._request('GET', '/v1/monitors'); }

  get(id) {
    if (!id) throw new InvalidInput('monitors.get() requires a monitor id.', { code: 'missing_monitor_id' });
    return this._client._request('GET', `/v1/monitors/${encodeURIComponent(id)}`);
  }

  cancel(id) {
    if (!id) throw new InvalidInput('monitors.cancel() requires a monitor id.', { code: 'missing_monitor_id' });
    return this._client._request('DELETE', `/v1/monitors/${encodeURIComponent(id)}`);
  }
}

export class ScriptHaul {
  constructor(options = {}) {
    const apiKey = options.apiKey || globalThis.process?.env?.SCRIPTHAUL_API_KEY;
    if (!apiKey) throw new InvalidInput('Set apiKey or SCRIPTHAUL_API_KEY.', {
      code: 'missing_api_key',
    });
    // Non-enumerable: console.log(client), structured loggers, and debugger
    // dumps show the display prefix only. Keys are never logged.
    Object.defineProperty(this, 'apiKey', {
      value: String(apiKey), enumerable: false, writable: false, configurable: false,
    });
    this.keyPrefix = String(apiKey).slice(0, 12);
    this.baseUrl = String(options.baseUrl || globalThis.process?.env?.SCRIPTHAUL_BASE_URL || DEFAULT_BASE_URL)
      .replace(/\/+$/, '');
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new ConfigurationError('A Fetch-compatible transport is required.', {
      code: 'missing_fetch',
    });
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    // Longest Retry-After the client will sleep through. Daily caps advertise
    // a day; nobody wants a call that blocks until UTC midnight.
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
    this.maxPolls = options.maxPolls ?? 120;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.jobPollIntervalMs = options.jobPollIntervalMs ?? 2000;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 600_000;
    this.waitThroughPauses = Boolean(options.waitThroughPauses);
    this._sleep = options.sleep || sleep;
    this.jobs = new Jobs(this);
    this.channels = new Channels(this);
    this.library = new Library(this);
    this.monitors = new Monitors(this);
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `ScriptHaul { baseUrl: '${this.baseUrl}', apiKey: '${this.keyPrefix}...' }`;
  }

  _url(path) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new InvalidInput('The API returned a cross-origin polling URL.', {
        code: 'unsafe_poll_url',
      });
    }
    return url;
  }

  async _request(method, path, options = {}) {
    let url = this._url(path);
    let requestMethod = String(method).toUpperCase();
    let body = options.body;
    let polls = 0;
    for (;;) {
      // A transient failure cannot tell us whether an unkeyed POST committed.
      // GET polling remains retryable after a 202 changes the request method.
      // A failed discovery search still spends proxy bytes: retry it at most
      // once, even when the caller permits more retries for other endpoints.
      const retryLimit = requestMethod === 'POST' && !hasIdempotencyKey(options.headers) ? 0
        : requestMethod === 'GET' && url.pathname.endsWith('/v1/search') ? Math.min(this.maxRetries, 1)
          : this.maxRetries;
      let response;
      let payload;
      let payloadRead = false;
      for (let attempt = 0; ; attempt += 1) {
        payload = undefined;
        payloadRead = false;
        try {
          response = await this.fetch(url, {
            method: requestMethod,
            // API routes never redirect. Manual handling ensures a custom
            // Fetch implementation cannot forward the Bearer key elsewhere.
            redirect: 'manual',
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              accept: 'application/json',
              'x-scripthaul-sdk': SDK_HEADER,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...options.headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: options.signal,
          });
        } catch (cause) {
          if (attempt < retryLimit) {
            await this._sleep(this.retryDelayMs * (2 ** attempt));
            continue;
          }
          throw new ClientNetworkError('The ScriptHaul API could not be reached.', {
            code: 'network_error', retryable: true, details: { cause: String(cause) },
          });
        }
        if (!RETRY_STATUSES.has(response.status) || attempt >= retryLimit) break;
        payload = await responseBody(response);
        payloadRead = true;
        // The envelope's verdict wins: a daily cap says retryable:false with a
        // day-long Retry-After, and three more requests cannot change that.
        if (payload && typeof payload === 'object' && payload.retryable === false) break;
        const delay = retryAfterMs(response, payload);
        if (delay != null && delay > this.maxRetryAfterMs) break;
        await this._sleep(delay ?? this.retryDelayMs * (2 ** attempt));
      }

      if (!payloadRead) payload = await responseBody(response);
      if (response.status === 202 && options.poll202) {
        if (++polls > this.maxPolls) {
          throw new ClientTimeout('Timed out waiting for the transcript.', {
            code: 'poll_timeout', retryable: true,
            request_id: payload?.request_id || response.headers.get('x-request-id'),
          });
        }
        if (!payload?.poll_url) throw apiError(response, payload);
        await this._sleep(pollDelay(response, this.pollIntervalMs));
        url = this._url(payload.poll_url);
        requestMethod = 'GET';
        body = undefined;
        continue;
      }
      if (!response.ok) throw apiError(response, payload);
      return attachMeta(payload, responseMeta(response));
    }
  }

  transcript(videoId, options = {}) {
    if (!videoId) throw new InvalidInput('transcript() requires a video id.', {
      code: 'missing_video_id',
    });
    const query = queryString({
      video_id: videoId, format: options.format, language: options.language,
      fallback: options.fallback, raw: options.raw, fresh: options.fresh,
    });
    return this._request('GET', `/v1/transcript?${query}`, { poll202: true });
  }

  videos(input, options = {}) {
    if (!input) throw new InvalidInput('videos() requires a channel, playlist, or list input.', {
      code: 'missing_video_input',
    });
    const query = queryString({
      url: input, contents: options.contents, offset: options.offset,
    });
    return this._request('GET', `/v1/videos?${query}`);
  }

  search(query, options = {}) {
    if (!query) throw new InvalidInput('search() requires a query.', {
      code: 'missing_search_query',
    });
    return this._request('GET', `/v1/search?${queryString({
      q: query, type: options.type, channel: options.channel,
      continuation: options.continuation,
    })}`);
  }
}

export default ScriptHaul;
