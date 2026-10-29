// Privacy canary through the real SDK: a client filename, a person's name, an
// email, a storage key, a case name and a prompt are planted in every carrier
// a report has (message, cause, codes, tags, extra, fingerprint, breadcrumbs,
// frames, a function and a class named after data, a console line, a process
// warning, a best-effort failure) and none may reach the transport, in either
// install mode. The unit tests check each rule; this checks the whole path.
import { afterEach, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { bestEffort, markStage, reportError, reportProcessWarning, resetSentryForTests, scrubEvent, setOperation } from './sentry';
import { diagnosticEvent, privacyBoundaryIntegration } from './sentryPrivacy';
import { AppError } from '../appError';
import { StorageOperationError } from '../storage';

const CANARIES = ['Jane_Doe_NDA.pdf', 'Jane Doe', 'jane@acme-law.example', 'documents/u1/d1/source.pdf', 'Acme Corp v. Doe', 'PRIVATE_PROMPT'];

afterEach(async () => { await Sentry.close(); });

it.each(['community', 'official'] as const)('lets no planted client data reach the transport in %s mode', async install => {
  const events: Array<Record<string, unknown>> = [];
  resetSentryForTests(install, { initialized: true });
  Sentry.init({
    dsn: 'https://test@sentry.invalid/1',
    defaultIntegrations: false,
    attachStacktrace: true,
    integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => { for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload as Record<string, unknown>); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const quietWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  // Scope tags and breadcrumbs: vocabulary keys with data values, plus real ones.
  setOperation('documents.upload.complete');
  const scope = Sentry.getIsolationScope();
  for (const [key, value] of Object.entries({ request_id: 'Jane_Doe_NDA.pdf', error_kind: 'Jane_Doe_NDA.pdf', error_code: 'Jane_Doe_NDA.pdf', warning_code: 'DEP1234 Jane_Doe_NDA.pdf', http_route: '/documents/Jane_Doe_NDA.pdf', what: 'Jane_Doe_NDA.pdf', filename: 'Jane_Doe_NDA.pdf' })) scope.setTag(key, value);
  Sentry.addBreadcrumb({ category: 'mike.stage', message: 'Jane_Doe_NDA.pdf', data: { filename: 'Jane_Doe_NDA.pdf' } });
  Sentry.addBreadcrumb({ category: 'http', message: 'GET /documents/Jane_Doe_NDA.pdf' });
  markStage('process-file');

  // An AppError chain whose every message, code and extra carries data.
  const cause = Object.assign(new Error('AccessDenied for documents/u1/d1/source.pdf uploaded by jane@acme-law.example'), { code: 'Jane_Doe_NDA.pdf', status: 'Jane Doe' });
  reportError(new AppError('upload.sealed_missing', 'Sealed Jane_Doe_NDA.pdf is missing', { cause: new StorageOperationError('download', { cause }) }), {
    tags: { component: 'upload-worker', stage: 'process-file', filename: 'Jane_Doe_NDA.pdf', job_kind: 'Jane_Doe_NDA.pdf', operation: 'Jane_Doe_NDA.pdf' },
    extra: { document_id: 'Jane_Doe_NDA.pdf', filename: 'Jane_Doe_NDA.pdf', path: '/documents/Jane_Doe_NDA.pdf', error_stack: 'Error: Acme Corp v. Doe\n    at readDocument (backend/src/lib/x.ts:1:1)' },
    fingerprint: ['Jane_Doe_NDA.pdf'],
  });
  // A function and a class named after data.
  const named = { 'Jane_Doe_NDA.pdf': function () { return new Error('Acme Corp v. Doe'); } };
  class JaneDoeNDAError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'Jane Doe NDA Error'; } }
  reportError(new JaneDoeNDAError('PRIVATE_PROMPT', { cause: named['Jane_Doe_NDA.pdf']() }), { tags: { component: 'http' } });
  // Process warnings with data in the text, the code and the name.
  reportProcessWarning(Object.assign(new Error('Jane_Doe_NDA.pdf is deprecated'), { name: 'DeprecationWarning', code: 'Jane_Doe_NDA.pdf' }));
  reportProcessWarning(Object.assign(new Error('Acme Corp v. Doe'), { name: 'Jane_Doe_NDA.pdf', code: 'DEP0040' }));
  // The console bridge and a best-effort failure.
  console.error('[storage] Jane_Doe_NDA.pdf failed', { key: 'documents/u1/d1/source.pdf', error: new Error('jane@acme-law.example') });
  await bestEffort(Promise.reject(new Error('Acme Corp v. Doe')), { what: 'Jane_Doe_NDA.pdf', extra: { key: 'documents/u1/d1/source.pdf' } });
  await Sentry.flush(3000);
  quiet.mockRestore();
  quietWarn.mockRestore();

  expect(events.length).toBeGreaterThanOrEqual(5);
  const wire = JSON.stringify(events);
  for (const canary of CANARIES) expect(wire, `${canary} reached the transport`).not.toContain(canary);
  // What an event may say: vocabulary, a normalised route, our frames.
  expect(wire).toContain('"operation":"documents.upload.complete"');
  expect(wire).toContain('"error_kind":"storage.download_failed"');
  expect(wire).toContain('"http_route":"/documents/:id"');
  expect(wire).toContain('"message":"process-file"');
});

// Client-shaped events go through the same boundary function: a notice with a
// free-text action, the API client's raw path, the add-in's edit identifiers.
it('lets no planted client data through a browser or add-in shaped event', () => {
  const wire = JSON.stringify([
    diagnosticEvent({ tags: { component: 'notify', action: 'rename Jane_Doe_NDA.pdf', operation: 'documents.edit', error_code: 'internal_error', request_id: '11111111-2222-4333-8444-555555555555' }, exception: { values: [{ type: 'MikeApiError', value: 'Jane_Doe_NDA.pdf could not be renamed' }] } }),
    diagnosticEvent({ message: 'API 500 on PUT /documents/Jane_Doe_NDA.pdf', tags: { component: 'mike-api', http_route: '/documents/Jane_Doe_NDA.pdf?name=Jane%20Doe', http_status: 500, operation: 'documents.edit' }, extra: { path: '/documents/Jane_Doe_NDA.pdf?name=Jane%20Doe' }, fingerprint: ['api-5xx', 'PUT', '/documents/Jane_Doe_NDA.pdf', '500'] }),
    diagnosticEvent({ tags: { component: 'word-office', operation: 'word.edit_apply', stage: 'apply', office_code: 'ItemNotFound' }, extra: { stableEditId: 'Jane_Doe_NDA.pdf', bookmarkName: 'Jane Doe' } }),
  ]);
  for (const canary of CANARIES) expect(wire, `${canary} in a client-shaped event`).not.toContain(canary);
  expect(wire).toContain('"request_id":"11111111-2222-4333-8444-555555555555"');
  expect(wire).toContain('"http_route":"/documents/:id"');
});

it.each(['community', 'official'] as const)('retains new authored diagnostics but drops an upstream name and kind in %s mode', async install => {
  const events: Array<Record<string, unknown>> = [];
  resetSentryForTests(install, { initialized: true });
  Sentry.init({
    dsn: 'https://test@sentry.invalid/1', defaultIntegrations: false,
    integrations: [privacyBoundaryIntegration()], beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => { for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload as Record<string, unknown>); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  class FreshOperationError extends AppError {}
  const dependency = Object.assign(new Error('private customer response'), {
    name: 'JaneDoeClaimError', kind: 'jane_doe.claim', code: 'ECONNRESET',
    responseBody: 'private customer response',
  });
  setOperation('new_feature.run');
  markStage('new-feature-step');
  reportError(new FreshOperationError('new_feature.failed', 'Operation failed', { cause: dependency }));
  // Automatic/unwrapped dependency captures must follow the same rule.
  Sentry.captureException(dependency);
  await Sentry.flush(2000);
  expect(events).toHaveLength(2);
  const wire = JSON.stringify(events);
  expect(wire).toContain('FreshOperationError');
  expect(wire).toContain('new_feature.failed');
  expect(wire).toContain('new_feature.run');
  expect(wire).toContain('new-feature-step');
  expect(wire).toContain('ECONNRESET');
  expect(wire).not.toContain('JaneDoeClaim');
  expect(wire).not.toContain('jane_doe');
  expect(wire).not.toContain('private customer response');
});
