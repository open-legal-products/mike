# Streaming effect audit, 2026-09-29

This follows [the assistant update-depth investigation](2026-09-29-assistant-update-depth.md)
and [PR #556](https://github.com/open-legal-products/mike/pull/556). The audit branch
starts at that fix, so the failures below are additional to the scroll-button
effect already fixed there. All reproduction data is synthetic; no provider,
customer account or production database is used.

## Confirmed failures

### Reasoning disclosures schedule state on every text chunk

The web and Word `ReasoningBlock` implementations both measured overflow and set
several state values in an effect depending on `text`. The effect also mirrored
`isStreaming` into open/closed state. Most of those values stayed unchanged.

In the real Next development renderer, eight saved exchanges followed by 150
reasoning deltas at a requested 1ms interval, with Chromium CPU throttled 4x,
reproduced **Maximum update depth exceeded** even with #556 applied. These are
requested timer intervals, not a claim that a busy browser processed each chunk
in 1ms. A temporary diagnostic trace showed repeated `ReasoningBlock` passive
updates accumulating through depths 47–50; a subsequent stream update crossed
the limit at 51. The checked-in Playwright case reproduces the warning without
patching React. It failed before this fix and passed afterwards.

`useReasoningDisclosure` now owns the behavior for both targets. It derives the
default disclosure state from stream status, preserving explicit user choices.
A ResizeObserver watches the unclipped content; measurement is coalesced into
one animation frame, and the last published overflow value is compared before
calling a setter. Closing or unmounting cancels pending work. There is no effect
depending on the streamed text and no initial mount solely to measure hidden
historical reasoning.

The warning was reproduced in the web renderer. The Word copy shared the faulty
effect, but Word batches stream publication differently; that alone does not
establish an identical warning in its renderer. Both now exercise the shared
hook and have browser stress coverage.

### Stream chunks starve transcript positioning and visibility

The web assistant and tabular-chat history positioning effects depended on the
entire `messages` array. They hid loaded history until deferred positioning
completed: two animation frames in the assistant, a 100ms timer in tabular chat.
Each streamed chunk ran cleanup and restarted that work. Sustained traffic could
therefore leave a resumed conversation behind a skeleton or at opacity zero.
This is a liveness failure, not another maximum-depth exception.

Regressions reproduced both cases on the parent branch:

- Web: load a resumed transcript, then interleave 120 chunk updates with one
  animation frame each. The transcript remained at opacity zero.
- Tabular: reopen a chat with an active server turn and deliver 50 chunks every
  20ms. After a full second the loaded history was still invisible, although
  streamed content existed in the DOM.

The positioning effects now depend on chat/loading state, whether messages
exist, and the user-message count. Chunk updates leave the positioning callback
alive. The regression assertions run before `[DONE]`; waiting for completion
would mask the bug. Existing same-length chat-switch and geometry tests remain
part of validation.

### Text animation loses elapsed time and never sleeps

A frame-controlled test delivered 120 deltas, each 1ms before its next 16ms
animation frame. The old effect cancelled the frame and reset `lastTick` on each
new text length. After 1.92 seconds only 42 of 220 available characters were
visible. Separate assertions proved that an empty/caught-up stream still owned
an animation frame and that restarting after inactive history could briefly
hide already completed text.

The scheduler now updates its target without replacing a pending frame, retains
elapsed time, compares the published integer before dispatch, sleeps when caught
up, and wakes on a new backlog. Inactive text and shorter replacements synchronize
the cursor; unmount cancels the outstanding frame. These are timing/liveness
bugs, not evidence that this hook independently caused the original passive-depth
warning.

### Refreshed tabular data resets the document selection

The side panel's reset effect depended on `row`, `documents` and `document`
objects. Replacing those objects with equivalent refreshed data changed the
selected source back to the initial document and reopened a pane the user had
collapsed. A 300-refresh regression failed before the fix. The reset now depends
on cell/row/document identities and citation values; genuine navigation still
resets the view.

### Out-of-order tabular histories replace the selected conversation

The initial history effect and manual history loader both published responses
without checking whether the user had moved on. Tests reproduced a late initial
response replacing another chat, and sixteen A/B selections resolving backwards
leaving selection zero on screen. History requests now carry a generation; only
the current one may publish messages, warnings or completion. New chat, deletion
of the selected chat, and unmount retire pending requests. Checking only chat ID
would be insufficient for A → B → A.

### A fast session response races the app shell's hydration

The reverse-history browser fixture intentionally resolves authentication without
an artificial delay. It exposed a separate hydration mismatch: an outer auth
provider could finish before the streamed page layout hydrated. The server had
rendered the loading shell, while the layout's first client render already used
the authenticated shell. A `renderToString`/`hydrateRoot` regression reproduced
the same recovery error independently of Next.

The page layout now retains its existing server loading shell until that layout
has mounted. This is a single mount transition, independent of auth changes or
streamed text. It preserves SSR markup and does not delay requests with an
arbitrary timeout. The hydration unit regression passes; the browser check also
exercises Strict Mode's replayed initial history requests.

## Scope of exploration

An AST-assisted inventory found 375 effects across 405 web/shared/add-in source
files. This is an inventory, not a claim that every interaction was exhaustively
verified. Manual follow-up prioritized state-setting effects with streaming
inputs, parent callback cycles, external-store snapshots and layout observers.

| Area | Assessment |
| --- | --- |
| Reasoning disclosure, web and Word | Shared per-chunk state effect removed; web warning reproduced |
| Web and tabular transcript reveal | Deferred-work starvation reproduced and fixed |
| Word scroll controls and live positioning | Scroll setter already guards its ref; live positioning uses a layout effect keyed by user-message identity |
| Composer model selection and sidebar activity | Actual callers memoize configured model/chat-ID arrays; existing behavior tests exercised, no additional loop established |
| Remount-persistent state and Word quick-action store | Snapshots return cached values rather than allocating on every read; no new loop established |
| Document-table parent callbacks and selection | Memoized derived selection and stable parent callbacks inspected; no new loop established |
| Tabular document side panel | Selection reset reproduced under 300 equivalent row/document refreshes and fixed |
| Breadcrumb measurement | Inspected; no demonstrated feedback loop, left unchanged |
| Smoothed text reveal | Lost elapsed time, idle frame scheduling and stale restart cursor reproduced and fixed |
| Tabular history selection | Reversed request completion reproduced stale transcript replacement; generation guard added |

## Prevention and limits

The browser regressions use paced ReadableStreams, long transcripts, constrained
CPU and live disclosure/viewport changes. The web reasoning case reaches sixteen
exchanges; the Word case sends sixteen exchanges in Chromium and WebKit. Console
errors and uncaught exceptions fail the checks. Unit regressions exercise 300
chunk updates, coalesced resize notifications, user choice, reopening, Strict
Mode cleanup and transcript visibility during an unfinished stream.

The Word workflow now runs the entire suite against a development bundle
as well as its production suite. The web workflow likewise runs its full stack
in both modes, alongside focused hermetic streaming tests. Chromium stress
fixtures use 4x CPU throttling; WebKit has no equivalent CDP control. Mark those
checks required in branch protection: a workflow
definition cannot itself enforce repository settings. The review guidance lives
in [frontend-testing.md](../frontend-testing.md#review-effects-for-update-loops-and-starvation).

React's specific passive-depth diagnostic is development-only. Its absence in
production or Sentry does not prove that the effect pattern was harmless. The
positioning-starvation behavior is ordinary application logic and is not gated
by React's development mode. This audit does not establish that a particular
customer saw that separate symptom, or why their development warning was absent
from Sentry; it does not change error-reporting policy.


## Expanded flow coverage

| Check | Conditions and flow coverage | Result |
| --- | --- | --- |
| Complete Word suite | Development bundle; Chromium UI fixtures at 4x CPU; Chromium and WebKit; auth, model setup, workflows/quick actions, history/persistence, tools/edits, citations, stop/rejoin, transport/error recovery, layout | 360 cases passed, zero retries/skips, 10.1 minutes locally |
| Six web streaming scenarios | General assistant, project assistant and tabular chat; each content + reasoning; eight saved exchanges, four content follow-ups or eight reasoning follow-ups; requested 1ms deltas, 4x CPU; live expand/collapse and 480px resize | All six passed, no console errors/uncaught exceptions, 7.4 minutes with two isolated workers |
| Web history/hydration browser | Sixteen A/B selections while long histories are held; reverse completion; immediate session resolution; development Strict Mode request replay; 480px resize | Passed, 40.4 seconds |
| Full web production stack, initial expanded profile | Disposable Supabase, Express and object storage; auth/accessibility, project/file operations, tabular reviews, workflows/settings, Google UI mocks, cold chat loads and original streaming regressions | 45 passed; four live-provider tests skipped |
| Full web matrix with all new scenarios | Same disposable stack, production + development; development adds 4x CPU and loop-diagnostic assertions | CI validation and exact code revision tracked on PR #557 |
| Frontend unit/component suite | All suites, plus frame scheduling, 300 refreshes, reversed history completion and hydration regressions | 1,785 tests passed in 217 suites, 119 seconds locally |

The Word counts include its parser/contract cases as well as UI flows. These are
all **currently defined test flows**, not every possible product interaction.
The synthetic browser fixtures do not exercise a live model provider, Google
account, or real Office host. PDF/DOCX/spreadsheet internals and many dialogs also
have component tests; this run does not claim every file format and document-size
combination was stress-tested in a real browser. Four existing live-provider web
cases remain key-gated. Production behavior and development warnings are both
checked, but a finite matrix cannot establish the absence of all future loops.
