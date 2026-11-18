# Tool-call validation

Mike checks the arguments of every tool call the model makes against the
tool's JSON Schema, with `@earendil-works/pi-schema` from Earendil's
MIT-licensed [Pi toolkit](https://github.com/earendil-works/pi), pinned at
1.5.2 in `backend/package.json`. It does not replace the Vercel AI SDK. The
package is an ES module and is loaded with `import()`, as the AI SDK is. Pi
publishes every package in lockstep and its API can change between minor
releases, so run the tests below when upgrading it.

## How it works

Code: `backend/src/lib/llm/toolInputValidation.ts`, wired into
`toAiSdkTools` in `backend/src/lib/llm/aiSdk.ts`.

The AI SDK parses a tool call's arguments as JSON but, given a plain
`jsonSchema()`, never checks them against the schema. Mike now passes a
`validate` function for every tool: built-in tools, web, CourtListener,
subagent, Word add-in, Google and MCP tools alike. `TOOL_INPUT_VALIDATION`
chooses what a mismatch does:

| Value | Effect |
|---|---|
| `log` (default) | The call runs exactly as before. A warn-level log line names the tool and each failing path and keyword, never the values. A path shows only names the schema declares and the indexes of arrays; a key the model wrote, numeric or not, is logged as `*`. |
| `enforce` | The call never runs. The SDK answers it with a message naming each failing path ("Nothing ran. Correct the arguments and call the tool again."), and the model can fix the call in its next step. The turn goes on. |
| `off` | No check. |

Validation is strict: nothing is coerced, so `"3"` for an integer is a
mismatch. A schema that does not compile, or has a `$ref` that points
nowhere (an MCP server's, for instance), leaves that tool unchecked rather
than unusable, with one warning per process.

The check cannot cost a turn:

- `pattern` and `patternProperties` are not checked. A connector's schema is
  another party's input, and one catastrophic regular expression run on the
  server's thread would stall every request. Where dropping them could refuse
  a valid call (beneath `not`, `if`, `oneOf`, `contains` or a `$ref`, or beside
  `unevaluatedProperties`), the tool
  is left unchecked instead.
- If pi-schema cannot be loaded, or a check throws, the call runs unchecked
  with one warning.

`format` is not checked either. OpenAPI's `nullable: true` is not JSON Schema
and is ignored, so in `enforce` a `null` for such a field is refused; look for
those tools in the `log` output first.

A schema that declares draft 4–7 in `$schema` (the Google tools do) is read
with draft-07 semantics; any other with 2020-12.

Roll out by leaving `log` on for a while, checking the `[tool-input]` warnings
for schemas that are stricter than their tools, and then setting `enforce`.

## Counting what the check did

Every outcome is counted per tool and written to the backend's log, so the
question "how many calls were refused, and for which tools?" has an answer in
either mode. Code: `backend/src/lib/toolActivity.ts`.

Counts are added up in memory and logged together as one line of JSON:

```text
[tool-activity] {"counts":[{"kind":"tool_input","tool":"read_document","outcome":"refused","count":2}]}
```

A count holds a kind, a tool, an outcome and a number. Nothing about the user,
the conversation or the arguments is logged. A connector tool's name contains
the connector's own name, so all connector tools are counted together as
`connector`.

`kind` is `tool_input` for the model's calls and `script_tool_input` for calls
made by a [`run_script`](run-script.md) script.

| Outcome | Meaning |
|---|---|
| `passed` | The arguments matched the schema. |
| `refused` | `enforce`: the call did not run and the model was told why. |
| `mismatch_allowed` | `log`: the arguments did not match and the call ran anyway. |
| `check_failed` | The checker threw, so the call ran unchecked. |
| `schema_unchecked` | The tool was offered with a schema that cannot be checked. Counted each time it is offered, not per call. |
| `checker_unavailable` | pi-schema did not load for one model request (tool `all`). |

To total them from saved logs, with every replica's lines in one file:

```bash
grep -h '^\[tool-activity\] ' backend.log | sed 's/^\[tool-activity\] //' \
  | jq -s 'map(.counts[]) | map(select(.kind == "tool_input"))
      | group_by([.tool, .outcome])
      | map({tool: .[0].tool, outcome: .[0].outcome, count: (map(.count) | add)})'
```

Refusals, mismatches and failures are logged within a tick. Passed checks are
logged every 30 seconds and at shutdown, so a process that is killed can lose
up to 30 seconds of `passed` counts. The numbers last as long as your logs do:
keep three weeks of backend logs, or send them to a log drain, before relying
on them. `TOOL_ACTIVITY_COUNTS=off` stops counting.

With `SENTRY_LOGS=on` each count also goes to Sentry: as a `tool_activity`
counter and as a `[tool-activity] counted` log, both with `kind`, `tool` and
`outcome` attributes (the log also carries `count`). In Sentry's Metrics
explorer, sum `tool_activity` grouped by `tool` and filtered to
`outcome:refused` to see refusals per tool; no log retention of your own is
needed. See [Structured logs and metrics](observability.md#structured-logs-and-metrics).

## Settings

```bash
# backend/.env
TOOL_INPUT_VALIDATION=log   # log | enforce | off
TOOL_ACTIVITY_COUNTS=on     # off to stop counting
```

## Tests

```bash
npm test --prefix backend -- src/lib/llm/toolInputValidation.test.ts \
  src/lib/llm/toolInputValidation.counts.test.ts src/lib/toolActivity.test.ts
```

The tests run real `streamText` loops against a stub model and compile every
built-in tool schema.
