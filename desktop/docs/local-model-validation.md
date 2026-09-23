# Mac app validation — 23 September 2026

## Test environment

The native tests ran on an Apple M1 with 8 GB unified memory. Other applications
were present; this was not an isolated performance lab. During the 4B full-app run,
the system reported about 9 GB of swap in use. Timings describe this machine and
run, not guaranteed latency or legal-task accuracy.

The app was built as a complete unsigned Apple Silicon application. It included
all local services and the pinned Ollama runtime; model weights were outside the
application. Both model downloads were verified against their reviewed manifest
digests. Each suite used disposable accounts/data and fabricated contract facts.
No paid model provider or real client document was used.

## Why the smallest download is not the only decision

The direct runtime checks passed for both candidates:

| Native check | Qwen 3.5 2B, Q8_0 | Qwen 3.5 4B, Q4_K_M |
| --- | ---: | ---: |
| Optional download | 2.74 GB | 3.39 GB |
| Synthetic extraction | 3/3 facts | 3/3 facts |
| Extraction latency | 4.0 s | 8.0 s |
| Output throughput | 16.9 tokens/s | 8.8 tokens/s |
| Structured function call with three correct arguments | 6.0 s | 16.9 s |

These short requests do not include Mike's full instructions and tools. The
original full-app tests exposed failures that the runtime checks missed:

- **2B:** the two extraction runs took 40.1 and 27.0 seconds. Facts were correct,
  but formatting was wrong; one run unnecessarily asked the user a question.
  A real workflow-listing roundtrip completed in 48.8 seconds.
- **4B on 8 GB:** extraction took 139.3 and 45.4 seconds. The first returned the
  right facts in the wrong format; the second passed. Workflow listing took
  85.4 seconds and returned four genuine titles when asked for three. It passed
  the tool roundtrip but failed strict task completion.

The 4B comparison used an 8K context limit rather than a 16K allocation. A larger
model did not justify becoming the default. New installations therefore use 2B
on every supported Mac. The managed starter uses
a shorter instruction preset to leave more room for the user's task. Its scope,
constraints and actual full-app results are covered below. Other model providers
and the Word add-in's replacement prompt retain their normal behavior.

## Compact preset results

The managed preset reduces the system policy from 2,452 to 794 tokens using the
official Qwen tokenizer. With the same ten tool schemas, the text count falls
from 4,801 to 3,143 tokens before dynamic context and chat-template framing. No
tools or permission checks were removed. Managed requests default to temperature
zero and no thinking; explicit temperature overrides remain supported.

The packaged 2B comparison completed two fact extractions and one workflow lookup
in 37.4, 42.7 and 42.1 seconds. All facts and the three requested workflow titles
were correct, with no unnecessary clarification. Strict formatting passed only
the first extraction: the second collapsed its labels onto one line, and the
workflow answer added a preamble. The strict quality suite therefore **failed**;
these results must not be described as a model-quality pass.

The 4B compact comparison on the reused workspace timed out at the 180-second
response limit. That workspace had queued memory-consolidation jobs as well as
system memory pressure; these observations do not establish which factor caused
the delay. The failing runs and raw responses were retained.

To test the requested first-use experience independently, a fresh 2B run cloned
only the approved model files into new app data. It copied no database, accounts,
cookies, memory, jobs or preferences. Each request used a distinct chat and exactly
one unchanged user prompt:

| Fresh packaged app check | Observed result |
| --- | --- |
| Local stack boot | 20.6 s to load the local frontend |
| Local guest access | Passed; model selected automatically, external research off |
| First extraction | 17.5 s; all three facts and exact three-line format passed |
| Second extraction | 6.4 s; all three facts and exact three-line format passed |
| Workflow lookup | 13.2 s; one real tool call, three genuine titles |

The workflow answer added an introductory sentence despite being asked for only
titles. The strict suite **still failed that formatting condition**. This is a
functional starter with observed instruction-following limits, not a perfect
three-task quality pass or evidence of legal competence. Tests do not repair or
hide the generated answer to make it pass. A used workspace and background work
can be substantially slower than the fresh-install figures.

## Packaged first launch and workspace

The final unsigned app built from commit `45ef0c06` passed:

```sh
MIKE_E2E_DEV=0 npm run e2e:local --prefix desktop
```

This used fresh application data and the packaged executable, without the
`--local` shortcut. The real welcome page opened the `app.asar` Local AI page,
which displayed Qwen 3.5 2B and its optional 2.7 GB download. Continuing without
AI downloaded no model files. The local stack then completed signup/onboarding,
project creation, PDF upload and signed-URL download, and both first-time and
returning local guest access. A separate byte comparison confirmed that the
downloaded PDF exactly matched the uploaded fixture.

There were no renderer errors. After Electron's normal quit path, the database,
frontend and model ports were free. Screenshots and the synthetic
run summary are retained under ignored `desktop/e2e/artifacts/local-*` files.
This passed workspace/onboarding check does not change the model-quality
failures above or establish signed-release acceptance.

## Reproducing the checks

Follow the build instructions in the [desktop README](../README.md), then run:

```sh
npm test --prefix desktop
npm run e2e:models --prefix desktop
npm run e2e:local --prefix desktop
npm run e2e:model-smoke --prefix desktop
node desktop/e2e/mike-model.e2e.mjs
node desktop/e2e/mike-model.e2e.mjs --fresh
```

The real model suites are opt-in and must run sequentially. The native smoke
retains its disposable cache so the full-app test can reuse it. To reproduce the
4B comparison on the same hardware, run both scripts with `--model=4b`. `--fresh`
starts with new app data and copies only the approved model cache; it requires
enough free space if the filesystem cannot clone files without copying bytes.
The full-app harness saves raw synthetic SSE, screenshots, post-tool answers and
strict quality results under ignored `desktop/e2e/artifacts/` directories. It
fails missing facts, unnecessary clarification/tool use, and the requested output
format. Transport success is not scored as task success.

The onboarding suite uses a fake runtime with real Electron main/preload/pages.
Its screenshots contain fixture measurements and must not be used as measured
performance claims.

## Release boundaries

No Developer ID Application identity was available on the test Mac. Packaging and
native execution were tested unsigned; Apple signing, notarization, Gatekeeper on
a freshly downloaded artifact, updates preserving real user data and a separate
16 GB machine remain release checks. The generated signing config includes the
required nested service and model-runtime executables. Native header checks
confirmed ARM64 availability and minimum macOS versions no later than 14.0 for
Postgres, GoTrue, PostgREST, Ollama and its runner; this does not replace a real
macOS 14 release test.

The local three-fact measurement is a smoke check. It does not validate long
contracts, legal research, citation fidelity across documents, jurisdictions or
comparative performance against commercial legal assistants. The 8K allocation
includes system instructions, tools, history and output. Use short excerpts and
review the model's work; evaluate representative firm tasks before deciding that
a larger deployment or fine-tuning is worth buying.

Training jobs and firm deployment provisioning are outside these two Mac PRs.
The in-app guide exports a local, data-free deployment brief and describes the
next steps; it does not sell an unimplemented training capability as available.
