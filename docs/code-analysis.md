# Code analysis

The assistant can run Python over the documents in a chat or project chat:
totals and groupings across spreadsheets, reconciliations between a schedule
and an agreement, date arithmetic, and the figures behind a
[visual](visuals.md). It is on for each user until they turn it off under
**Settings > Features > Code Analysis**, and off for a whole deployment with
`CODE_ANALYSIS_ENABLED=false`. Tabular review and the Word add-in do not run
code.

## How a run works

The assistant names the documents a run may read. Spreadsheets are mounted
as files and read with pandas or openpyxl; every other document is mounted
as its extracted text. Each run is a fresh interpreter with numpy, pandas,
openpyxl, python-dateutil and regex, and nothing else: there is no network
and nothing can be installed. The run prints what the assistant wants to
see, can return a structured result, and can save up to three tables, which
become `.xlsx` documents in the chat (cells that look like formulas are kept
as text). The chat shows a "Ran code" entry with the code and its output.

A structured result can be handed straight into a visual, so the numbers the
page shows are the numbers the run produced.

## Limits

| Limit | Default | Variable |
| --- | --- | --- |
| Wall clock per run | 30 s | `PYTHON_SANDBOX_TIMEOUT_MS` (at most 120000) |
| Memory per run | 1 GB | `PYTHON_SANDBOX_MEMORY_MB` |
| Runs at once | 2 | |
| Documents per run | 10 | |
| Input per run | 25 MB of files; larger files are mounted as text | |
| Output | 20,000 characters printed, 2 MB result, 3 saved files | |
| Results kept for visuals | 8 MB per answer | |
| Runs per answer | 25, plus 25 per subagent and 50 for all subagents together | |

A run that passes a limit is stopped and the assistant is told why, so it
can aggregate or sample and try again. A result over about 20 KB reaches
the assistant as a preview of its shape (its keys, and the first items of
each list) rather than in full; the whole result stays available to a
visual under its run id.

## The sandbox

Runs and the headless browser that exports visuals live in a separate
Compose service, `sandbox`, built from the backend image. It has no network,
no secrets, a non-root user and a read-only filesystem, and the backend
reaches it over a unix socket on a shared volume (`SANDBOX_SOCKET`). A fresh
`docker compose up -d --build` starts it; nothing else is needed.

That container is the boundary. Inside it there is a second layer: the
interpreter runs in a short-lived child process with a scrubbed environment,
killed after every run; the child refuses Node's network modules, the package
installer and the JavaScript bridge, runs with code generation from strings
disabled, and mounts files read-only. That layer narrows what a run can do;
it is not what keeps a deployment safe.

Deployments without Compose (nixpacks, railpack, a single container) have no
sandbox service. The backend then runs both in its own process, but only in
development, or in production when `SANDBOX_ALLOW_LOCAL=true` is set. Without
that, code analysis and PDF and Word export report themselves unavailable and
visuals, the HTML download and the viewer keep working. With the fallback the
interpreter runs with the backend container's filesystem access and egress
(only its environment is scrubbed), and the process that holds the
deployment's secrets also hosts Chromium, so prefer the service where you
can. Such a build must also run `npm run pyodide:fetch` and
`npx playwright-core install --with-deps --only-shell chromium` in
`backend/`; the Dockerfile does, nixpacks and railpack do not.

To check a deployment, run the self-test in the sandbox container:

```bash
docker compose exec sandbox node dist/sandbox/selfTest.js
```

It runs a short program, renders a page, and tries to open a network
connection, which must fail.

## Building the image

The backend image fetches headless Chromium and the Python wheels during the
build (`backend/scripts/fetch-pyodide-packages.mjs`, with pinned hashes), so a
running container never downloads. On a development machine, run
`npm run pyodide:fetch --prefix backend` once; without the wheels the backend
reports code analysis unavailable and the runtime tests are skipped.
