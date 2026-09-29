# Streaming regression recordings

These GIFs are shortened recordings of **passing Playwright tests** on
September 29, 2026. They use synthetic histories/API responses, real development
React/browser rendering and 4x Chromium CPU throttling. No customer data, live
model provider or real Office host is involved. The clips illustrate the flows;
the tests' assertions establish correct state and absence of console errors.

| Recording | What it shows | Source test and edit |
| --- | --- | --- |
| [Assistant content](assistant-content.gif) | Streaming after eight saved exchanges, continued through twelve exchanges, followed by the scroll-to-bottom control | [Assistant streaming](../../../e2e/assistant-streaming.spec.ts), content case; source seconds 25–38 and 226–238.8, both at 1.5x playback |
| [Assistant reasoning](assistant-reasoning.gif) | Expanded reasoning, narrow viewport, minimise/disclosure interaction and later follow-ups through sixteen exchanges | [Assistant streaming](../../../e2e/assistant-streaming.spec.ts), reasoning case; seconds 98–108 at normal speed, then 147–157.4 at 1.5x |
| [History ordering](history-order.gif) | Sixteen A/B selections while requests are held, reverse response completion, and the final selection after a narrow resize | [Tabular history](../../../e2e/tabular-chat-lifecycle.spec.ts); seconds 3–11.3 at 0.75x playback, with a one-second final hold |
| [Word reasoning](word-reasoning.gif) | Reasoning/disclosure/resize interaction at exchange ten and subsequent messages through exchange sixteen | [Word streaming](../../../word-addin/e2e/assistant-streaming.spec.ts); seconds 24–50 at 1.5x, cropped to the task pane |

All GIFs use 8 fps. Cropping, trimming and playback-speed changes are the only
content edits. Full videos and test traces remain local/CI artifacts rather than
being committed. The web recording run passed all three selected cases (6.8m);
the Word recording passed its sixteen-exchange case (52s).

## Record again

Start a local development frontend with no existing service on port 3107:

```bash
NEXT_PUBLIC_SENTRY_DISABLED=true SENTRY_DISABLED=true \
  npm run dev --prefix frontend -- --hostname 127.0.0.1 --port 3107
```

In another terminal, record the hermetic browser regressions:

```bash
PW_VIDEO=1 CI=true PLAYWRIGHT_BASE_URL=http://127.0.0.1:3107 \
  npx playwright test e2e/assistant-streaming.spec.ts \
  e2e/tabular-chat-lifecycle.spec.ts \
  --grep 'long assistant conversations|tabular chat keeps' \
  --project=chromium --no-deps --retries=0 --workers=1 --reporter=list
```

With no existing server on port 3100, record Word:

```bash
PW_VIDEO=1 WORD_E2E_DEVELOPMENT=1 REACT_STRESS=1 \
  npm run test:e2e --prefix word-addin -- \
  e2e/assistant-streaming.spec.ts --project=chromium --retries=0
```

Videos are written as `video.webm` in each test's results directory. Recording is
opt-in and disabled in normal CI. The tests still execute their complete flows
and error assertions when recording is enabled. See the
[audit](../../incidents/2026-09-29-streaming-effects-audit.md) for before/after
failure evidence, the larger test matrix and its limits.
