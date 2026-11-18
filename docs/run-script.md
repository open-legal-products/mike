# run_script

`run_script` lets the model write a short JavaScript program that calls the
read-only document tools in a loop. It runs in the sandbox from
`@earendil-works/pi-codemode`, part of Earendil's MIT-licensed
[Pi toolkit](https://github.com/earendil-works/pi), pinned at 1.5.2 in
`backend/package.json` (its QuickJS engine comes from `quickjs-wasi`). It does
not replace the Vercel AI SDK. The package is an ES module and is loaded with
`import()`. Pi publishes every package in lockstep and its API can change
between minor releases, so upgrade it together with `pi-schema` (see
[Tool-call validation](tool-call-validation.md)) and run the tests below.

## How it works

Code: `backend/src/modules/chat/engine/tools/scriptTool.ts`, dispatched from
`runTools` in `backend/src/modules/chat/engine/streaming.ts`.

`run_script` is off unless `SCRIPT_TOOL=on`. When on, chats and project chats
offer it whenever the turn offers at least one of these read-only tools:
`list_documents`, `find_documents`, `find_in_document`, `read_document`,
`fetch_documents` and `read_table_cells`. The model writes the body of an
async JavaScript function that calls them as `await tools.<name>(args)` and
returns a compact result, so a question such as "which of these 80 agreements
have a change-of-control clause?" costs one model step instead of dozens.
Subagents are not offered it.

What a script can and cannot do:

- It runs in a QuickJS sandbox on a worker thread. It has no network, file
  system, timers, process or modules.
- It can call only the allowlisted tools that the turn already offers the
  model. Nothing that writes, asks the user, delegates or reaches a connector
  is exposed, and asking for another tool throws in the script.
- Each call goes through the ordinary tool dispatcher, one at a time, with the
  turn's document scope, ownership and project-sharing checks. The calls are
  held to their schemas whatever `TOOL_INPUT_VALIDATION` says (see
  [Tool-call validation](tool-call-validation.md)).
- The documents a script reads or searches appear in the turn's events like
  any other read. A script keeps its own record of what it read: the model has
  not seen that text, so its own `read_document` still returns the full
  document, which it needs before quoting or citing.
- A failed call throws in the script with only "`<tool>` failed."; the cause is
  reported to Sentry under `chat.tool_failed` with operation
  `chat.script_tool`. A script's own error message is returned to the model,
  which wrote the code.

Limits per script: 200 tool calls, 120 seconds (tool time included), 64 MB of
VM memory, 20,000 characters of code and 40,000 characters of result (a longer
result comes back as an error with a preview). At most 4 scripts run at once
per process; another is refused and the model is told to use the tools
directly. Stopping the answer stops the script.

## Settings

```bash
# backend/.env
SCRIPT_TOOL=off   # on to offer run_script
```

## Tests

```bash
npm test --prefix backend -- src/modules/chat/engine/tools/scriptTool.test.ts \
  src/modules/chat/engine/__tests__/streamingScriptTool.test.ts
```

The tests run real scripts in the sandbox: limits, timeouts, stops,
unexposed tools, what reaches the model, and how a script's calls go through
the chat engine's dispatcher.
