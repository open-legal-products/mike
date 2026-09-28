/**
 * Final outbound boundary, after SDK processors and before transport serialization.
 * Mirrored in frontend/src/shared/lib/sentryPrivacy.ts; the sync test guards drift.
 * Never infer whether arbitrary text is PII. Rebuild diagnostic events from an
 * allowlist and reject every other envelope item, including automatic sessions.
 */
type RecordValue = Record<string, unknown>;
type Envelope = [RecordValue, Array<[{ type: string; [key: string]: unknown }, unknown]>];
interface Transport {
  send(envelope: Envelope): PromiseLike<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ID = /^[0-9a-f]{16,32}$/i;
const ENUMS: Record<string, ReadonlySet<string>> = Object.fromEntries(Object.entries({
  service: 'mike-backend mike-frontend mike-word-addin',
  role: 'api worker worker-thread job',
  runtime: 'browser server edge',
  surface: 'taskpane commands dialog',
  install: 'community official',
  component: 'http mike-api api-gateway dbq storage upload-worker conversion-worker extraction-worker app-jobs chat-stream chat-title assistant-chat word-chat word-office boot shutdown worker-shutdown worker-thread worker-thread-supervisor stale-sweep mcp-refresh-sweep workflow-sync best-effort route-error-boundary global-error-boundary',
  stage: 'runtime-config manifest-key listen shutdown-http shutdown-workers shutdown-flush gateway-config gateway-fetch gateway-response conversion heartbeat process-file iteration failure-hook claim tick retention delivery docx-to-pdf copy-rollback anchor-cleanup resolve-cleanup resolve restore reveal locate citation-select release document-read resolve-batch tool-result sealed-source-after-process failed-file-sealed session-expiry seal-mismatch seal-recover session-cancel user-prefix-cleanup failed-document-remove',
  http_method: 'GET POST PUT PATCH DELETE HEAD OPTIONS',
  error_code: 'internal_error network_error',
  capture_source: 'exception console unhandled message',
  diagnostics_version: '2',
  build_mode: 'development production test',
  failure_code: 'ECONNREFUSED ECONNRESET EADDRINUSE ETIMEDOUT ENOTFOUND EAI_AGAIN ENOENT EACCES EPERM ENOSPC EPIPE ERR_SERVER_NOT_RUNNING UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_SOCKET CERT_HAS_EXPIRED DEPTH_ZERO_SELF_SIGNED_CERT AccessDenied InvalidAccessKeyId SignatureDoesNotMatch NoSuchBucket NoSuchKey SlowDown ServiceUnavailable RequestTimeout 23505 23503 23514 22003 22P02 28P01 28000 42P10 42883 42501 42P01 42703 53300 57014 08006 PGRST100 PGRST116 PGRST200 PGRST201 PGRST202 PGRST203 PGRST204 PGRST205 configuration_invalid signing_key_invalid conversion_unavailable conversion_timeout conversion_failed fetch_failed',
  provider_error: 'invalid_api_key api_call retry_exhausted',
  network_state: 'online offline unknown',
  request_origin: 'same-origin cross-origin unknown',
  file_type: 'pdf doc docx odt rtf ppt pptx xls xlsx csv txt html',
  diagnostic_test: 'true',
  office_code: 'GeneralException InvalidArgument InvalidObjectPath ItemNotFound AccessDenied NotAllowed DocumentNotSaved UnsupportedOperation InvalidOperation InvalidReference',
  office_host: 'Word',
  office_platform: 'PC Mac OfficeOnline Universal iOS Android',
  job_kind: 'audit.chat_turn account.delete storage.cleanup document.cleanup export.build conversion.convert extraction.extract mcp.refresh_token document.precompute_text memory.consolidate',
  storage: 'local cloud',
  storage_operation: 'HEAD copy upload download delete',
}).map(([key, values]) => [key, new Set(values.split(' '))]));
const ROUTE_PARTS = new Set(('word-chat orgs single-documents tabular-review quick-actions workflow-addons audit manifest-signing-key api auth login logout refresh session user users projects directory people access memory ids filter-options folder-paths resolve folder documents versions files folders upload uploads upload-sessions parts complete abort content download preview source text conversion chats chat messages stream cancel assistant tabular tabular-reviews reviews rows columns cells run results export workflows templates library models configured ollama openrouter vercel opencode-go settings profile organizations members permissions shares keys api-keys health observability sentry-test').split(' '));
const ID_KEYS = new Set(('request_id requestId document_id documentId file_id fileId job_id jobId review_id reviewId row_id rowId session_id sessionId version_id versionId').split(' '));
const CONFIGURATION_FIELDS = new Set('SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY AUTH_HANDOFF_ENCRYPTION_SECRET FRONTEND_URL API_PUBLIC_URL WORD_ADDIN_URL'.split(' '));
const ERROR_TYPES = new Set('Error TypeError RangeError ReferenceError SyntaxError URIError EvalError AggregateError AbortError TimeoutError APIError StorageOperationError'.split(' '));
const LEVELS = new Set('fatal error warning info debug'.split(' '));

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

/** Only fixed route vocabulary survives; names, ids, queries and fragments do not. */
export function diagnosticRoute(value: string): string {
  return (value.replace(/^(?:https?:)?\/\/[^/]+/i, '').split(/[?#]/)[0] || '/')
    .split('/').slice(0, 16).map(part => !part || ROUTE_PARTS.has(part) ? part : ':id').join('/');
}

/** Stack locations are code, never the document currently being processed. */
function codePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.split(/[?#]/)[0]!.replace(/\\/g, '/');
  const bundle = clean.match(/(?:^|\/)((?:taskpane|commands|oauth-dialog|\d+)(?:\.[0-9a-f]{8})?\.js)$/);
  if (bundle) return bundle[1];
  const start = clean.search(/(?:^|\/)(?:backend|frontend|word-addin|packages|src|dist|node_modules|_next)\//);
  const path = start >= 0 ? clean.slice(start).replace(/^\//, '') : clean;
  if (!/^(?:(?:backend|frontend|word-addin|packages|src|dist|node_modules|_next)\/|\.\/|webpack(?:-internal)?:\/\/)/.test(path)) return undefined;
  return /^[\w@./()[\]~!:+ -]+\.[cm]?[jt]sx?$/.test(path) ? path : undefined;
}

function tagsFor(value: unknown): RecordValue {
  const out: RecordValue = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'string' && Object.hasOwn(ENUMS, key) && ENUMS[key]!.has(entry)) out[key] = entry;
    else if (ID_KEYS.has(key) && typeof entry === 'string' && UUID.test(entry)) out[key] = entry;
    else if (key === 'configuration_fields' && typeof entry === 'string' && entry.length < 250 && entry.split(',').every(field => CONFIGURATION_FIELDS.has(field))) out[key] = entry;
    else if (key === 'office_version' && typeof entry === 'string' && /^\d+(?:\.\d+){1,4}$/.test(entry) && entry.length < 30) out[key] = entry;
    else if (key === 'http_route' && typeof entry === 'string') out[key] = diagnosticRoute(entry);
    else if ((key === 'http_status' || key === 'dependency_status') && /^\d{3}$/.test(String(entry)) && Number(entry) >= 100 && Number(entry) <= 599) out[key] = Number(entry);
    else if ((key === 'network' || key === 'project') && (entry === true || entry === false || entry === 'true' || entry === 'false')) out[key] = entry;
  }
  return out;
}

/** Extract only finite diagnostic vocabulary, including wrapped/AggregateError causes.
 * Never copy error messages, SQL details, storage keys, URLs or SDK metadata.
 */
export function diagnosticErrorTags(error: unknown): Record<string, string | number> {
  const tags: Record<string, string | number> = {};
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let n = 0; pending.length && n < 12; n++) {
    const candidate = pending.shift();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const item = candidate as RecordValue;
      if (typeof item.operation === 'string' && ENUMS.storage_operation!.has(item.operation)) tags.storage_operation = item.operation;
      if (Array.isArray(item.configurationFields)) {
        const fields = [...new Set(item.configurationFields.slice(0, 10).filter(field => typeof field === 'string' && CONFIGURATION_FIELDS.has(field)))];
        if (fields.length) tags.configuration_fields = fields.sort().join(',');
      }
      const providerError = item.name === 'InvalidApiKeyError' ? 'invalid_api_key'
        : item.name === 'AI_APICallError' ? 'api_call'
          : item.name === 'AI_RetryError' ? 'retry_exhausted' : undefined;
      if (providerError && tags.provider_error === undefined) tags.provider_error = providerError;
      if (item.code === 'sentry_test') tags.diagnostic_test = 'true';
      for (const code of [item.code, item.name]) {
        if (typeof code === 'string' && ENUMS.failure_code!.has(code) && tags.failure_code === undefined) tags.failure_code = code;
      }
      const status = item.status ?? item.statusCode ?? record(item.$metadata).httpStatusCode;
      if (Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 && tags.dependency_status === undefined) tags.dependency_status = Number(status);
      if (item.cause) pending.push(item.cause);
      if (item.lastError) pending.push(item.lastError);
      if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 5));
    } catch {
      // Host objects/proxies may have throwing accessors. Reporting must not throw.
    }
  }
  if (tags.failure_code === undefined) {
    try {
      // Compare entire fixed runtime messages; never retain any of their text.
      const message = record(error).message;
      if (typeof message === 'string' && ['Failed to fetch', 'fetch failed', 'Load failed', 'NetworkError when attempting to fetch resource.'].includes(message)) tags.failure_code = 'fetch_failed';
    } catch { /* Exotic errors must not break reporting. */ }
  }
  return tags;
}

function framesFor(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap(raw => {
    const frame = record(raw);
    const filename = codePath(frame.filename) ?? codePath(frame.abs_path);
    if (!filename) return [];
    const out: RecordValue = { filename };
    // abs_path/debug ids are needed to match uploaded source maps.
    if (codePath(frame.abs_path)) out.abs_path = codePath(frame.abs_path);
    for (const key of ['lineno', 'colno']) {
      if (Number.isSafeInteger(frame[key]) && Number(frame[key]) >= 0) out[key] = frame[key];
    }
    if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app;
    // Omit function names, source snippets, local variables and SDK frame extras.
    return [out];
  });
}

/** Nested console Errors arrive as a stack string; retain locations, not its message. */
function consoleFrames(value: unknown): RecordValue[] {
  if (typeof value !== 'string') return [];
  return framesFor(value.split('\n').slice(1, 101).flatMap(line => {
    const match = line.match(/(?:\(|\s)((?:(?:\.\/)?(?:backend|frontend|word-addin|packages|src|dist|node_modules|_next)\/|\/|[A-Za-z]:\\|https?:\/\/|webpack)[^\n]*?):(\d+):(\d+)\)?$/);
    return match ? [{ filename: match[1], lineno: Number(match[2]), colno: Number(match[3]) }] : [];
  }).reverse());
}

export function diagnosticEvent(value: unknown): RecordValue {
  const event = record(value);
  const tags = tagsFor(event.tags);
  const out: RecordValue = { tags };
  // Broad software versions aid reproduction without user-agent strings or devices.
  const softwareNames: Record<string, ReadonlySet<string>> = {
    browser: new Set(['Chrome', 'Chrome Mobile', 'Edge', 'Firefox', 'Safari', 'Mobile Safari', 'Opera']),
    runtime: new Set(['node', 'Node.js']),
  };
  const contexts: RecordValue = {};
  for (const [key, names] of Object.entries(softwareNames)) {
    const software = record(record(event.contexts)[key]);
    if (typeof software.name !== 'string' || !names.has(software.name)) continue;
    const version = typeof software.version === 'string' && /^v?\d+(?:\.\d+){0,3}$/.test(software.version) && software.version.length < 30 ? software.version : undefined;
    contexts[key] = { name: software.name, ...(version ? { version } : {}) };
  }
  if (Object.keys(contexts).length) out.contexts = contexts;
  if (typeof event.event_id === 'string' && HEX_ID.test(event.event_id)) out.event_id = event.event_id;
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) out.timestamp = event.timestamp;
  if (typeof event.level === 'string' && LEVELS.has(event.level)) out.level = event.level;
  if (event.platform === 'javascript' || event.platform === 'node') out.platform = event.platform;
  // Release/environment are operator-supplied build configuration, never request data.
  for (const key of ['release', 'environment']) {
    if (typeof event[key] === 'string' && /^[\w@.+/-]{1,100}$/.test(event[key])) out[key] = event[key];
  }
  const description = [tags.component ?? 'application', tags.stage, tags.http_method, tags.http_route, tags.http_status, tags.error_code, tags.office_code, tags.failure_code, tags.storage_operation, tags.provider_error, tags.dependency_status].filter(v => v !== undefined).join(' / ');
  const values = record(event.exception).values;
  const exceptionValues = Array.isArray(values) ? values : [];
  // attachStacktrace gives captureMessage() a synthetic exception (mechanism
  // synthetic:true, value = the message text) so the call site is recorded.
  // It is still a message event: keep `message` (the title callers and the
  // e2e contract read) and carry the synthetic frames as its stacktrace,
  // instead of turning every reportApiFailure into an "Error".
  const syntheticMessage = typeof event.message === 'string' && exceptionValues.length > 0
    && exceptionValues.every(raw => record(record(raw).mechanism).synthetic === true);
  if (exceptionValues.length && !syntheticMessage) {
    const nestedFrames = consoleFrames(record(event.extra).error_stack);
    out.exception = { values: exceptionValues.slice(0, 10).map((raw, index) => {
      const exception = record(raw);
      const type = typeof exception.type === 'string' && ERROR_TYPES.has(exception.type) ? exception.type : 'Error';
      const safe: RecordValue = { type, value: `${tags.diagnostic_test === 'true' ? 'Diagnostic test' : 'Failure'} in ${description}` };
      // attachStacktrace gives console messages a synthetic exception. Prefer
      // the nested Error's actual throw site over that console call site.
      const frames = tags.capture_source === 'console' && nestedFrames.length && index === Math.min(exceptionValues.length, 10) - 1
        ? nestedFrames : framesFor(record(exception.stacktrace).frames);
      if (frames.length) safe.stacktrace = { frames };
      const handled = record(exception.mechanism).handled;
      if (typeof handled === 'boolean') safe.mechanism = { type: 'generic', handled };
      return safe;
    }) };
  } else {
    out.message = `${tags.diagnostic_test === 'true' ? 'Diagnostic test' : 'Failure'} in ${description}`;
    const frames = framesFor(record(event.stacktrace).frames);
    if (syntheticMessage) for (const raw of exceptionValues.slice(0, 10)) frames.push(...framesFor(record(record(raw).stacktrace).frames));
    frames.push(...consoleFrames(record(event.extra).error_stack));
    if (frames.length) out.stacktrace = { frames };
  }
  // Group by code location and controlled operation, never arbitrary text.
  out.fingerprint = ['{{ default }}', String(tags.component ?? 'application'), String(tags.stage ?? ''), String(tags.http_route ?? ''), String(tags.http_status ?? ''), String(tags.failure_code ?? ''), String(tags.file_type ?? ''), String(tags.provider_error ?? ''), String(tags.dependency_status ?? '')];
  const extra: RecordValue = {};
  for (const [key, entry] of Object.entries(record(event.extra))) {
    if (ID_KEYS.has(key) && typeof entry === 'string' && UUID.test(entry)) extra[key] = entry;
  }
  if (Object.keys(extra).length) out.extra = extra;
  const images = record(event.debug_meta).images;
  if (Array.isArray(images)) {
    const safeImages = images.flatMap(raw => {
      const image = record(raw);
      const code_file = codePath(image.code_file);
      return image.type === 'sourcemap' && typeof image.debug_id === 'string' && UUID.test(image.debug_id) && code_file
        ? [{ type: 'sourcemap', code_file, debug_id: image.debug_id }] : [];
    });
    if (safeImages.length) out.debug_meta = { images: safeImages };
  }
  return out;
}

/** Drop all non-error telemetry, even if a future SDK enables it by default. */
export function diagnosticEnvelope(envelope: Envelope, destination?: string): Envelope | null {
  const items: Envelope[1] = envelope[1].flatMap(([header, payload]) => header.type === 'event'
    ? [[{ type: 'event' }, diagnosticEvent(payload)] as Envelope[1][number]] : []);
  if (!items.length) return null;
  const header: RecordValue = {};
  // Next's tunnel needs a DSN. Use client configuration, never envelope input.
  if (destination && envelope[0].dsn !== undefined) header.dsn = destination;
  const id = envelope[0].event_id;
  if (typeof id === 'string' && HEX_ID.test(id)) header.event_id = id;
  return [header, items];
}

/** Applies to browser, server, workers and add-in, in both install modes. */
export function privacyBoundaryIntegration() {
  return {
    name: 'MikePrivacyBoundary',
    setup(client: {
      getTransport(): Transport | undefined;
      getDsn?(): { protocol: string; publicKey?: string; host: string; port?: string; path?: string; projectId: string } | undefined;
    }) {
      const transport = client.getTransport();
      if (!transport) return;
      const send = transport.send.bind(transport);
      const dsn = client.getDsn?.();
      const destination = dsn?.publicKey ? `${dsn.protocol}://${dsn.publicKey}@${dsn.host}${dsn.port ? `:${dsn.port}` : ''}/${dsn.path ? `${dsn.path}/` : ''}${dsn.projectId}` : undefined;
      let windowStart = Date.now();
      let sent = 0;
      transport.send = envelope => {
        const safe = diagnosticEnvelope(envelope, destination);
        if (!safe) return Promise.resolve({});
        const now = Date.now();
        if (now - windowStart >= 60_000) { windowStart = now; sent = 0; }
        // Runtime-wide bound supplements per-issue throttling; not an auth boundary.
        if (sent + safe[1].length > 60) return Promise.resolve({});
        sent += safe[1].length;
        return send(safe);
      };
    },
  };
}
