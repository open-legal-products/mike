# Notification and recovery review boundaries

The notifications/tracking base only mounts passive toast hosts, classifies safe
messages, preserves request IDs and deduplicates reporting. It does not change
password validation, session replay, chat submission, mutations, persistence or
support navigation. Action-capable UI primitives and diagnostic builders are
inert until a feature explicitly wires them up.

The recovery work is split into four draft children, in review order:

1. Web authentication: password limits, authentication messages, session-check
   retries, sign-in and support actions.
2. Web chat: retrying a failed turn, transcript restoration and lifecycle guards.
3. Web workspace/settings: retrying loads and mutations, optimistic rollback,
   empty/error states, crash recovery and support escalation.
4. Word: authentication replay, chat retry, document edit deduplication, local
   persistence, history safeguards and host/browser support hand-off.

**Each child requires explicit user approval of its listed behavior before it
may be marked ready or merged.** Creating the stack is not approval to ship it.
Keep the children draft and do not enable auto-merge. Passing tests establishes
implementation confidence; it does not approve a product behavior change.
