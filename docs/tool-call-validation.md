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

## Settings

```bash
# backend/.env
TOOL_INPUT_VALIDATION=log   # log | enforce | off
```

## Tests

```bash
npm test --prefix backend -- src/lib/llm/toolInputValidation.test.ts
```

The tests run real `streamText` loops against a stub model and compile every
built-in tool schema.
