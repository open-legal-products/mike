import { afterEach, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { reportProcessWarning, resetSentryForTests, scrubEvent } from './sentry';
import { toProviderStreamError } from '../llm/providerErrors';
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
