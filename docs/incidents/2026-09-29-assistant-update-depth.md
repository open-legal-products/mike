# Assistant streaming: maximum update depth

The customer reported a React development-console warning after eight user
messages in one conversation, with a stack pointing to `useSmoothedReveal`.
The reproduction used main `54e66261c3d1528564fe3eba2876a7849ad832e3`, including
its locked Next.js 16.3.5 and React 19.3.0 dependencies.

This records the original scroll-effect diagnosis. The subsequent
[class audit](2026-09-29-streaming-effects-audit.md) adds six related fixes,
including reveal scheduling, and expands the regression matrix. Both are
consolidated in [PR #556](https://github.com/open-legal-products/mike/pull/556).

## Reproduction and cause

Short streamed replies did not reliably trigger the warning, even after more
than 30 follow-ups. A real Chromium/Next development session with eight saved
synthetic exchanges (100 Markdown paragraphs per answer), a four-times CPU
slowdown and a new reply delivered in 120 separate chunks did trigger the exact
warning and `useSmoothedReveal[useEffect() > step]` stack.

Read-only instrumentation of the browser's React development bundle recorded
consecutive passive-effect updates from `ChatView.updateScrollButton`, including
counts 38 through 50. The next reveal animation update encountered count 51 and
reported the warning. React's development limit is 50. This is a stream/render
timing interaction, not a hard limit of eight messages.

`ChatView` depended on the entire `messages` array in the scroll-listener effect.
Each streamed chunk produced a new array, reran the effect, and called
`setShowScrollButton`. Setting the same boolean is not sufficient protection:
React may enqueue the update when other concurrent work is pending. The effect
repeatedly scheduled updates while React was flushing passive effects. The final
stack identified the setter that encountered the limit, not the effect that
built up the count.

The fix measures actual content/viewport resizing and scroll events, coalesces
measurements with `requestAnimationFrame`, and checks visibility before calling
the state setter. It observes the revealed content as well as the viewport and
cleans up the observer, listener and pending animation frame. That initial fix
did not change reveal animation; the subsequent audit separately reproduced and
fixed reveal starvation and idle scheduling.

## Production impact

The faulty scroll effect runs in both development and production builds. The
extra measurements and state-update calls therefore also exist in production.
React's production bundle omits this particular passive-effect depth counter
and console warning; it retains a separate guard for other nested-update errors.
Absence of this warning in production is not evidence that the faulty effect
was harmless. The confirmed reproduction is a development warning, however:
this investigation did not establish a production crash or quantify a
production performance regression.

## History

The offending scroll effect dates to the repository's initial import,
[`d9690965b`](https://github.com/Open-Legal-Products/mike/commit/d9690965b5b160ce68fde56e0950bd0f6b07a23b),
on April 29, 2026. GitHub associates no PR with that commit. The reveal hook was
introduced later in [PR #206](https://github.com/Open-Legal-Products/mike/pull/206)
and adjusted in [PR #219](https://github.com/Open-Legal-Products/mike/pull/219).
These facts do not establish either PR, or the latest main PR #540, as the first
release where customers encountered the interaction.

## Regression protection

`ChatView.actions.test.tsx` covers actual content growth without a message change,
viewport resizing, scrolling, 120 successive message updates, cleanup and the
transition from the initial screen to a conversation. Against the old code,
three new tests failed; the streaming test observed 120 geometry measurements
without any layout notifications.

`e2e/assistant-streaming.spec.ts` exercises the full frontend with paced synthetic
SSE and continues from eight exchanges to twelve. It fails on console errors
and uncaught exceptions and needs no provider key. With the original `ChatView`
restored, this test reproduced the exact warning on the first follow-up, without
instrumenting React. Its saved answers use 30 paragraphs each to keep the
regression smaller than the initial stress fixture. The dedicated development
job in `.github/workflows/e2e.yml` preserves React's passive-update warning;
the normal production browser suite alone cannot detect that warning. See
[the streaming test instructions](../frontend-testing.md#assistant-streaming-regressions).

With the fix, the same browser test passed all four follow-ups (twelve total
exchanges), with no console errors, and verified the scroll-to-bottom control.
A separate instrumented stress session completed eight follow-ups after eight
saved exchanges (sixteen total); its maximum passive-update count stayed at 1,
compared with 51 on the original code. The targeted Vitest run passed 45 tests
across the ChatView, reveal, timeline, mounted-send and chat-lifecycle suites.
Frontend typechecking, targeted ESLint, the browser spec's TypeScript check,
workflow YAML/shell parsing and `git diff --check` passed.

## Sentry findings and limits

The browser already installs Sentry's `captureConsoleIntegration` for
`console.error`. This warning should therefore enter the console capture path
when a development build emits it and reporting is enabled. It does not need to
be an uncaught exception. Production builds do not emit this specific warning,
so there is no corresponding console event for Sentry to capture there.

The final privacy boundary replaces free-text titles with controlled summaries
such as `Failure in application` and removes stack function names while retaining
code paths and line numbers. Searching Sentry for the original React warning or
hook name can miss a captured event. `tracesSampleRate: 0` affects tracing, not
error capture.

A recheck of the preceding 12 hours across environments found one frontend
event: an unrelated upload-session HTTP 500 in
[MIKE-FRONTEND-S](https://mike-xp.sentry.io/issues/MIKE-FRONTEND-S), with
`capture_source=exception` and `build_mode=development`. There was no matching
React console event. Sanitization explains search limitations; it does not
establish why this customer's report is missing. The customer's reporting
config, network delivery and Sentry ingestion outcome were unavailable. A
follow-up observability change should classify this fixed React diagnostic into
an allowlisted failure code and verify capture through the final sanitized
transport. Do not retain raw console arguments or relax the privacy boundary to
make it searchable.
