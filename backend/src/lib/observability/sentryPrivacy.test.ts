import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticEnvelope, diagnosticErrorTags, diagnosticEvent, diagnosticRoute, privacyBoundaryIntegration } from './sentryPrivacy';

const id = '8f1c2a3e-1234-4bcd-9e0f-1234567890ab';
const eventId = '1234567890abcdef1234567890abcdef';
afterEach(() => vi.restoreAllMocks());

describe('outbound telemetry privacy boundary', () => {
  it.each(['Synthetic_Client_Jane_Doe_NDA.pdf', 'Jane Doe medical claim', '秘密の依頼人契約.docx'])('drops client-controlled text in every event carrier: %s', privateName => {
    const out = diagnosticEvent({
      event_id: eventId, message: privateName, logentry: { message: privateName },
      transaction: privateName, fingerprint: [privateName], logger: privateName,
      request: { url: '/documents?filename=' + privateName, headers: { 'X-Custom-Secret': privateName }, query_string: privateName, data: privateName },
      user: { id: privateName }, server_name: privateName,
      breadcrumbs: [{ message: privateName, data: { filename: privateName } }],
      extra: { detail: privateName, name: privateName, message: privateName, error_stack: privateName, document_id: privateName },
      contexts: { trace: { data: privateName }, os: { name: privateName } },
      tags: { component: privateName, stage: privateName, document_id: privateName, error_code: privateName, http_route: '/documents/' + privateName + '?q=' + privateName },
      exception: { values: [{ type: privateName, value: privateName, module: privateName, mechanism: { data: privateName }, stacktrace: { frames: [{ filename: privateName, function: privateName, vars: { name: privateName }, context_line: privateName }] } }] },
      debug_meta: { images: [{ type: 'sourcemap', code_file: privateName, debug_id: privateName }] },
      future_sdk_field: privateName,
    });
    expect(JSON.stringify(out)).not.toContain(privateName);
    expect(out.tags).toEqual({ http_route: '/documents/:id' });
    expect(out).not.toHaveProperty('request');
    expect(out).not.toHaveProperty('breadcrumbs');
    expect(out).not.toHaveProperty('user');
  });

  it('retains actionable controlled diagnostics, correlation IDs, stack lines and source-map IDs', () => {
    const out = diagnosticEvent({
      event_id: eventId, timestamp: 123, level: 'error', platform: 'javascript', release: 'mike@abc123', environment: 'self-hosted',
      tags: { service: 'mike-backend', component: 'upload-worker', stage: 'conversion', http_method: 'POST', http_route: '/api/projects/' + id + '/documents', http_status: '500', request_id: id, network: true, project: 'false', error_code: 'internal_error' },
      extra: { document_id: id, filename: 'Private NDA.pdf' },
      exception: { values: [{ type: 'TypeError', value: 'Private NDA.pdf', mechanism: { handled: true, data: 'secret' }, stacktrace: { frames: [{ filename: '/Users/private/work/mike/backend/src/convert.ts', abs_path: '/Users/private/work/mike/backend/src/convert.ts', lineno: 42, colno: 7, in_app: true, function: 'privateName', context_line: 'privateName', vars: { secret: true } }] } }] },
      debug_meta: { images: [{ type: 'sourcemap', code_file: '/Users/private/work/mike/backend/src/convert.ts', debug_id: id }] },
    });
    expect(out).toMatchObject({ event_id: eventId, timestamp: 123, level: 'error', release: 'mike@abc123', environment: 'self-hosted', extra: { document_id: id }, tags: { request_id: id, http_route: '/api/projects/:id/documents', http_status: 500 } });
    expect(out.exception).toEqual({ values: [{ type: 'TypeError', value: 'Failure in upload-worker / conversion / POST / /api/projects/:id/documents / 500 / internal_error', mechanism: { type: 'generic', handled: true }, stacktrace: { frames: [{ filename: 'backend/src/convert.ts', abs_path: 'backend/src/convert.ts', lineno: 42, colno: 7, in_app: true }] } }] });
    expect(out.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: 'backend/src/convert.ts', debug_id: id }] });
    expect(JSON.stringify(out)).not.toContain('private');
  });

  it('handles browser bundle paths and removes URL credentials, query, fragment and host', () => {
    const out = diagnosticEvent({ stacktrace: { frames: [{ filename: 'https://private.example/_next/static/chunks/app.js?filename=Private.pdf#secret', lineno: 1, colno: 30 }, { filename: '/home/private/contract.pdf' }, { filename: undefined }] } });
    expect(out.stacktrace).toEqual({ frames: [{ filename: '_next/static/chunks/app.js', lineno: 1, colno: 30 }] });
    expect(out.message).toBe('Failure in application');
    expect(diagnosticRoute('https://private.example/api/documents/Private.pdf?q=private')).toBe('/api/documents/:id');
    expect(diagnosticRoute('')).toBe('/');
  });

  it('keeps nested console stack locations and Word bundle source-map links without their prose', () => {
    const out = diagnosticEvent({ extra: { error_stack: 'Error: Private NDA.pdf\n    at convert (/work/mike/backend/src/convert.ts:42:7)\ninvalid' }, debug_meta: { images: [{ type: 'sourcemap', code_file: 'http://localhost:3100/taskpane.1234abcd.js', debug_id: id }] } });
    expect(out.stacktrace).toEqual({ frames: [{ filename: 'backend/src/convert.ts', lineno: 42, colno: 7 }] });
    expect(out.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: 'taskpane.1234abcd.js', debug_id: id }] });
    expect(JSON.stringify(out)).not.toContain('Private NDA');
    expect(diagnosticEvent({ tags: { office_host: 'Word', office_platform: 'Mac', office_version: '16.0.123', job_kind: 'extraction.extract' } }).tags).toEqual({ office_host: 'Word', office_platform: 'Mac', office_version: '16.0.123', job_kind: 'extraction.extract' });
  });

  it('ignores tag names inherited from Object.prototype', () => {
    expect(diagnosticEvent({ tags: { constructor: 'constructor', toString: 'toString' } }).tags).toEqual({});
  });

  it.each(['session', 'sessions', 'client_report', 'transaction', 'attachment', 'replay_event', 'replay_recording', 'log', 'span', 'metric', 'profile', 'feedback', 'future_item'])('rejects %s items before network serialization', type => {
    expect(diagnosticEnvelope([{ trace: { transaction: 'Private.pdf' } }, [[{ type, filename: 'Private.pdf' }, { did: 'private-user' }]]])).toBeNull();
  });

  it('rebuilds mixed envelopes and removes payload sizes and arbitrary envelope metadata', () => {
    const safe = diagnosticEnvelope([{ event_id: eventId, trace: { transaction: 'Private.pdf' }, private: true }, [[{ type: 'session' }, { did: 'private' }], [{ type: 'event', length: 999, filename: 'Private.pdf' }, { message: 'Private.pdf' }]]]);
    expect(safe).toEqual([{ event_id: eventId }, [[{ type: 'event' }, diagnosticEvent({})]]]);
    expect(diagnosticEnvelope([{}, [[{ type: 'event' }, null]]])).toEqual([{}, [[{ type: 'event' }, diagnosticEvent({})]]]);
  });

  it('routes tunneled reports using the configured public DSN, never private envelope text', async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 200 });
    const transport = { send };
    privacyBoundaryIntegration().setup({ getTransport: () => transport, getDsn: () => ({ protocol: 'https', publicKey: 'public-key', host: 'sentry.example', port: '443', path: 'ingest', projectId: '123' }) });
    await transport.send([{ dsn: 'Private NDA.pdf' }, [[{ type: 'event' }, {}]]]);
    expect(send).toHaveBeenCalledWith([{ dsn: 'https://public-key@sentry.example:443/ingest/123' }, [[{ type: 'event' }, diagnosticEvent({})]]]);
  });

  it('bounds event volume across distinct issues, preserves transport responses and flush ownership', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const send = vi.fn().mockResolvedValue({ statusCode: 503 });
    const transport = { send, flush: vi.fn() };
    privacyBoundaryIntegration().setup({ getTransport: () => transport });
    const event: Parameters<typeof diagnosticEnvelope>[0] = [{}, [[{ type: 'event' }, { message: 'private' }]]];
    expect(await transport.send(event)).toEqual({ statusCode: 503 });
    for (let n = 0; n < 70; n++) await transport.send(event);
    expect(send).toHaveBeenCalledTimes(60);
    await transport.send([{}, [[{ type: 'session' }, { did: 'private' }]]]);
    expect(send).toHaveBeenCalledTimes(60);
    clock.mockReturnValue(61_000);
    await transport.send(event);
    expect(send).toHaveBeenCalledTimes(61);
    expect(transport.flush).not.toHaveBeenCalled();
    expect(() => privacyBoundaryIntegration().setup({ getTransport: () => undefined })).not.toThrow();
  });
});


describe('bounded error diagnostics', () => {
  it('finds network causes inside an AggregateError without private prose', () => {
    const cause = Object.assign(new Error('private host / client document'), { code: 'ECONNREFUSED', address: 'private host' });
    const error = new TypeError('fetch failed', { cause: new AggregateError([cause]) });
    const tags = diagnosticErrorTags(error);
    expect(tags).toEqual({ failure_code: 'ECONNREFUSED' });
    expect(diagnosticEvent({ tags }).tags).toEqual(tags);
    expect(JSON.stringify(diagnosticEvent({ tags }))).not.toContain('private');
  });

  it('keeps storage status and known database codes, drops arbitrary codes and metadata', () => {
    const tags = diagnosticErrorTags({ name: 'AccessDenied', $metadata: { httpStatusCode: 403, requestId: 'private' } });
    expect(diagnosticEvent({ tags }).tags).toEqual({ failure_code: 'AccessDenied', dependency_status: 403 });
    expect(diagnosticErrorTags({ code: '42P01', message: 'private table' })).toEqual({ failure_code: '42P01' });
    expect(diagnosticErrorTags({ code: 'private client', name: 'private client', status: 'private' })).toEqual({});
    expect(diagnosticEvent({ tags: { failure_code: 'private', capture_source: 'private', file_type: 'private', dependency_status: 'private', diagnostic_test: 'private' } }).tags).toEqual({});
  });

  it('handles cyclic errors, huge aggregates and throwing accessors', () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(diagnosticErrorTags(cyclic)).toEqual({});
    expect(diagnosticErrorTags({ get code() { throw new Error('private'); } })).toEqual({});
    expect(diagnosticErrorTags({ errors: Array(1000).fill(cyclic) })).toEqual({});
  });

  it('groups distinct known causes separately while unknown text never affects grouping', () => {
    const fingerprint = (code: string) => diagnosticEvent({ tags: { failure_code: code } }).fingerprint;
    expect(fingerprint('ECONNREFUSED')).not.toEqual(fingerprint('ENOTFOUND'));
    expect(fingerprint('private A')).toEqual(fingerprint('private B'));
  });
});


it('retains only known software names and numeric versions, never user-agent data', () => {
  expect(diagnosticEvent({ contexts: {
    browser: { name: 'Chrome', version: '152.0.0', userAgent: 'private' },
    runtime: { name: 'node', version: 'v22.23.1', private: 'private' },
    device: { name: 'private' },
  } }).contexts).toEqual({ browser: { name: 'Chrome', version: '152.0.0' }, runtime: { name: 'node', version: 'v22.23.1' } });
  expect(diagnosticEvent({ contexts: { browser: { name: 'private', version: '1.0' }, runtime: { name: 'node', version: 'private' } } }).contexts).toEqual({ runtime: { name: 'node' } });
  expect(diagnosticErrorTags(new TypeError('Failed to fetch'))).toEqual({ failure_code: 'fetch_failed' });
  expect(diagnosticErrorTags(new TypeError('Failed to fetch private document'))).toEqual({});
});


it('separates diagnostic probes and allowlists configuration field names', () => {
  const probe = diagnosticEvent({ tags: diagnosticErrorTags({ code: 'sentry_test' }) });
  expect(probe.tags).toEqual({ diagnostic_test: 'true' });
  expect(probe.message).toBe('Diagnostic test in application');
  expect(diagnosticErrorTags({ configurationFields: ['SUPABASE_URL', 'private-value', 'SUPABASE_URL'] })).toEqual({ configuration_fields: 'SUPABASE_URL' });
  expect(diagnosticEvent({ tags: { configuration_fields: 'SUPABASE_URL,private' } }).tags).toEqual({});
});


it('retains a known storage operation and its dependency cause without object keys', () => {
  const error = { name: 'StorageOperationError', operation: 'HEAD', key: 'private-document', cause: { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } } };
  expect(diagnosticErrorTags(error)).toEqual({ storage_operation: 'HEAD', failure_code: 'AccessDenied', dependency_status: 403 });
  expect(diagnosticErrorTags({ operation: 'private-document' })).toEqual({});
});


it('distinguishes real project endpoints while dropping IDs and query content', () => {
  for (const operation of ['directory', 'people', 'access', 'memory']) {
    expect(diagnosticRoute(`/projects/${id}/${operation}?private=value`)).toBe(`/projects/:id/${operation}`);
  }
});


it('prefers the nested console Error throw site over the SDK synthetic message stack', () => {
  const event = diagnosticEvent({
    tags: { capture_source: 'console' },
    exception: { values: [{ type: 'Error', stacktrace: { frames: [{ filename: 'src/logging.ts', lineno: 8 }] } }] },
    extra: { error_stack: 'Error: PRIVATE_DOCUMENT\n    at failing (backend/src/operation.ts:42:7)' },
  });
  expect(event.exception).toMatchObject({ values: [{ stacktrace: { frames: [{ filename: 'backend/src/operation.ts', lineno: 42, colno: 7 }] } }] });
  expect(JSON.stringify(event)).not.toContain('PRIVATE_DOCUMENT');
});


it('retains provider categories and retry status without response bodies or credentials', () => {
  const api = { name: 'AI_APICallError', statusCode: 401, responseBody: 'PRIVATE_PROVIDER_RESPONSE', apiKey: 'PRIVATE_KEY', requestBodyValues: { prompt: 'PRIVATE_PROMPT' } };
  const retry = { name: 'AI_RetryError', lastError: api };
  const wrapped = { name: 'AssistantStreamError', cause: { name: 'InvalidApiKeyError', cause: retry } };
  const tags = diagnosticErrorTags(wrapped);
  expect(tags).toEqual({ provider_error: 'invalid_api_key', dependency_status: 401 });
  expect(diagnosticErrorTags(retry)).toEqual({ provider_error: 'retry_exhausted', dependency_status: 401 });
  expect(diagnosticErrorTags(api)).toEqual({ provider_error: 'api_call', dependency_status: 401 });
  expect(JSON.stringify(diagnosticEvent({ tags, extra: api }))).not.toContain('PRIVATE_');
  const cyclic: { lastError?: unknown } = {};
  cyclic.lastError = cyclic;
  expect(diagnosticErrorTags(cyclic)).toEqual({});
});

it('allows only bounded network context and known model endpoints', () => {
  expect(diagnosticEvent({ tags: { network_state: 'offline', request_origin: 'cross-origin' } }).tags).toEqual({ network_state: 'offline', request_origin: 'cross-origin' });
  expect(diagnosticEvent({ tags: { network_state: 'private-network', request_origin: 'https://private.example', provider_error: 'private' } }).tags).toEqual({});
  for (const operation of ['configured', 'ollama', 'openrouter', 'vercel', 'opencode-go']) {
    expect(diagnosticRoute(`/api/models/${operation}?key=private`)).toBe(`/api/models/${operation}`);
  }
});
