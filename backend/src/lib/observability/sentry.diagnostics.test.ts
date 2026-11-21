import { afterEach, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { reportProcessWarning, resetSentryForTests, scrubEvent, reportError, markErrorHandled } from './sentry';
import { toProviderStreamError } from '../llm/providerErrors';
import { eventBudget, eventBudgetLimits } from './sentryVolume';
import { MIKE_SENTRY_DSN } from './sentry';
import { privacyBoundaryIntegration } from './sentryPrivacy';

// The final transport also emits Sentry's legacy top-level message stack.
type DiagnosticEvent = Sentry.Event & { stacktrace?: { frames?: Array<{ filename?: string }> } };

afterEach(async () => { await Sentry.close(); });

it.each(['community', 'official'] as const)('retains exception and console locations through the real SDK in %s mode', async install => {
  const events: DiagnosticEvent[] = [];
  resetSentryForTests(install);
  Sentry.init({
    dsn: 'https://test@sentry.invalid/1',
    defaultIntegrations: false,
    attachStacktrace: true,
    integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === 'event') events.push(payload as DiagnosticEvent);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  const error = new TypeError('SYNTHETIC_PRIVATE_DOCUMENT', { cause: new AggregateError([Object.assign(new Error('SYNTHETIC_PRIVATE_DOCUMENT'), { code: 'ECONNREFUSED' })]) });
  Sentry.captureException(error);
  const relativeError = new Error('SYNTHETIC_PRIVATE_DOCUMENT');
  relativeError.stack = 'Error: SYNTHETIC_PRIVATE_DOCUMENT\n    at operation (backend/src/lib/storage.ts:42:7)';
  Sentry.captureException(relativeError);
  console.error('[diagnostic probe]', { error: new Error('SYNTHETIC_PRIVATE_DOCUMENT') });
  Sentry.captureMessage('SYNTHETIC_PRIVATE_DOCUMENT');
  const providerError = Object.assign(new Error('SYNTHETIC_PRIVATE_DOCUMENT'), { name: 'AI_APICallError', statusCode: 401, responseBody: 'SYNTHETIC_PRIVATE_DOCUMENT' });
  Sentry.captureException(new Error('SYNTHETIC_PRIVATE_DOCUMENT', { cause: toProviderStreamError(providerError, { label: 'Gemini', modelId: 'private-model' }) }));
  await Sentry.flush(2000);
  expect(events).toHaveLength(5);
  expect(events[4]?.tags).toMatchObject({ provider_error: 'invalid_api_key', dependency_status: 401 });
  expect(events[0]?.tags).toMatchObject({ failure_code: 'ECONNREFUSED', capture_source: 'exception' });
  expect(events[2]?.tags).toMatchObject({ capture_source: 'console' });
  expect(events[0]?.exception?.values?.[0]?.stacktrace?.frames?.some(f => f.filename?.endsWith('sentry.diagnostics.test.ts'))).toBe(true);
  const consoleFrames = events[2]?.exception?.values?.[0]?.stacktrace?.frames ?? events[2]?.stacktrace?.frames;
  expect(consoleFrames?.some(f => f.filename?.endsWith('sentry.diagnostics.test.ts'))).toBe(true);
  expect(events[1]?.exception?.values?.[0]?.stacktrace?.frames).toContainEqual(expect.objectContaining({ filename: 'backend/src/lib/storage.ts', lineno: 42, colno: 7 }));
  const messageFrames = events[3]?.exception?.values?.[0]?.stacktrace?.frames ?? events[3]?.stacktrace?.frames;
  expect(messageFrames?.some(f => f.filename?.endsWith('sentry.diagnostics.test.ts'))).toBe(true);
  expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PRIVATE_DOCUMENT');
});

// Node dedupes DeprecationWarnings by code for the life of the process.
const WARNING_CODES = { community: 'DEP9901', official: 'DEP9902' } as const;

it.each(['community', 'official'] as const)('reports a Node process warning once, with its name, code and origin, in %s mode', async install => {
  const events: DiagnosticEvent[] = [];
  resetSentryForTests(install, { initialized: true });
  Sentry.init({
    dsn: 'https://test@sentry.invalid/1',
    defaultIntegrations: false,
    attachStacktrace: true,
    integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === 'event') events.push(payload as DiagnosticEvent);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.on('warning', reportProcessWarning);
  try {
    process.emitWarning('SYNTHETIC_PRIVATE_DOCUMENT', 'DeprecationWarning', WARNING_CODES[install]);
    // Node emits the warning, and prints it through console.error, on a later tick.
    await new Promise(resolve => setImmediate(resolve));
    await Sentry.flush(2000);
  } finally {
    process.off('warning', reportProcessWarning);
    stderr.mockRestore();
  }
  expect(events).toHaveLength(1);
  const [event] = events;
  expect(event?.level).toBe('warning');
  expect(event?.tags).toMatchObject({ component: 'runtime-warning', warning_name: 'DeprecationWarning', warning_code: WARNING_CODES[install], capture_source: 'exception' });
  expect(event?.exception?.values?.[0]).toMatchObject({ type: 'DeprecationWarning', value: `Failure in runtime-warning / DeprecationWarning / ${WARNING_CODES[install]}` });
  // The frame that matters: where the warning was raised, not Node's printer.
  expect(event?.exception?.values?.[0]?.stacktrace?.frames?.some(f => f.filename?.endsWith('sentry.diagnostics.test.ts'))).toBe(true);
  expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PRIVATE_DOCUMENT');
});

it('preserves the primary exception, ownership, privacy and new failures through final SDK envelopes', async () => {
  const events: DiagnosticEvent[] = [];
  resetSentryForTests('official', { initialized: true });
  Sentry.init({
    dsn: 'https://test@sentry.invalid/1', defaultIntegrations: false,
    integrations: [privacyBoundaryIntegration({ acceptEvent: eventBudget({ repeatEventsPerDay: 0 }) }), Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend: scrubEvent,
    transport: () => ({ send: async envelope => {
      for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload as DiagnosticEvent);
      return { statusCode: 200 };
    }, flush: async () => true }),
  });
  const handled = Object.assign(new Error('SYNTHETIC_PRIVATE_REFUSAL'), { status: 429, code: 'rate_limited' });
  markErrorHandled(handled);
  const primary = Object.assign(new Error('SYNTHETIC_PRIVATE_DOCUMENT'), { code: 'ECONNRESET', status: 500 });
  primary.stack = 'Error: SYNTHETIC_PRIVATE_DOCUMENT\n    at stream (backend/src/modules/chat/engine/streaming.ts:42:7)';
  console.error('[chat] failed', primary, { previous: handled });
  const failure = new Error('SYNTHETIC_PRIVATE_DOCUMENT');
  failure.stack = 'Error: SYNTHETIC_PRIVATE_DOCUMENT\n    at save (backend/src/modules/documents/documents.versions.ts:80:2)';
  reportError(failure, { tags: { operation: 'documents.save', request_id: '123e4567-e89b-12d3-a456-426614174000' } });
  console.error('[save] failed', failure);
  console.error('[handled]', handled);
  await Sentry.flush(2000);
  expect(events).toHaveLength(2);
  expect(events[0]?.tags).toMatchObject({ failure_code: 'ECONNRESET', dependency_status: 500, occurrence: 1 });
  expect(events[0]?.exception?.values?.[0]?.stacktrace?.frames).toContainEqual(expect.objectContaining({ filename: 'backend/src/modules/chat/engine/streaming.ts', lineno: 42 }));
  expect(events[1]?.tags).toMatchObject({ operation: 'documents.save', request_id: '123e4567-e89b-12d3-a456-426614174000' });
  expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PRIVATE');
});

it('enforces the shared project ceiling through final SDK envelopes even with an explicit DSN', async () => {
  const events: Sentry.Event[] = [];
  resetSentryForTests('community');
  Sentry.init({
    dsn: MIKE_SENTRY_DSN.backend, defaultIntegrations: false,
    integrations: [privacyBoundaryIntegration({ acceptEvent: eventBudget(eventBudgetLimits(undefined, MIKE_SENTRY_DSN.backend, Object.values(MIKE_SENTRY_DSN))) })],
    beforeSend: scrubEvent,
    transport: () => ({ send: async envelope => {
      for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload as Sentry.Event);
      return { statusCode: 200 };
    }, flush: async () => true }),
  });
  for (let n = 0; n < 60; n++) Sentry.captureEvent({ message: 'PRIVATE_QUOTA_CANARY', tags: { diagnostic_test: 'true' } });
  await Sentry.flush(2000);
  expect(events).toHaveLength(50);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_QUOTA_CANARY');
});

it.each(['upstream-unavailable', 'api-unreachable', 'runtime-warning'])('budgets %s as one pinned issue across stack sites in final SDK envelopes', async pinned => {
  const events: Sentry.Event[] = [];
  resetSentryForTests('community');
  Sentry.init({
    dsn: 'https://test@sentry.invalid/1', defaultIntegrations: false,
    integrations: [privacyBoundaryIntegration({ acceptEvent: eventBudget({ repeatEventsPerDay: 0 }) })],
    beforeSend: scrubEvent,
    transport: () => ({ send: async envelope => {
      for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload as Sentry.Event);
      return { statusCode: 200 };
    }, flush: async () => true }),
  });
  for (let site = 0; site < 60; site++) {
    const error = new Error('PRIVATE_PINNED_CANARY');
    error.stack = `Error: PRIVATE_PINNED_CANARY\n    at operation (backend/src/site${site}.ts:42:7)`;
    Sentry.captureException(error, { level: 'warning', fingerprint: [pinned], tags: { component: 'api-gateway' } });
  }
  const unrelated = new TypeError('PRIVATE_PINNED_CANARY');
  unrelated.stack = 'TypeError: PRIVATE_PINNED_CANARY\n    at save (backend/src/save.ts:80:2)';
  Sentry.captureException(unrelated, { tags: { operation: 'documents.save' } });
  await Sentry.flush(2000);
  expect(events).toHaveLength(2);
  expect(events[0]?.fingerprint?.[0]).toBe(pinned);
  expect(events[1]?.tags?.operation).toBe('documents.save');
  expect(JSON.stringify(events)).not.toContain('PRIVATE_PINNED_CANARY');
});
