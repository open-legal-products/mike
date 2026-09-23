# Optional local AI

This child of Mac PR #351 implements [PRD #528](https://github.com/Open-Legal-Products/mike/issues/528).
The complete Mac app is the base download. The inference runtime is included;
weights are an optional second download inside the app. Users do not install
Docker, Node, a database, Homebrew or Ollama.

## First use

1. Open Mike, choose **Start on this Mac**.
2. Choose **Download local AI** or **Continue without local AI**. The latter
   opens workspace functions; AI needs an installed model or a configured provider.
3. After an integrity check and a real inference response, **Open local workspace**
   and **Continue on this Mac**. No cloud account or practice questionnaire is required.
4. Mike selects the ready local model only for an unset profile. New starter
   selections have external legal research off; users can explicitly change it.

The **Mike → Local AI** menu reopens download management and measurements. Model
downloads can be cancelled and retried; Ollama reuses retained partial blobs.
Quitting stops the managed runtime and model runners. Installed models and the
workspace persist in `~/Library/Application Support/Mike/local/` across app upgrades.

## Starter selection and boundaries

| Hardware | Starter | Download | Context |
| --- | --- | --- | --- |
| Apple Silicon, at least 8 GB RAM | Qwen 3.5 2B (Q8_0) | 2.7 GB | 8,192 tokens |

macOS 14+ is required. This starter preset is not a minimum-performance guarantee.
The same small starter is used on larger Macs: a larger download is
not assumed to improve the first experience. An explicit 4B developer comparison
remains available; it is not automatically recommended to users. Previously
selected approved models are retained even if hardware changes, with context
capped to 8K below 16 GB RAM.
The app checks free disk space before download and reserves another 1 GiB. Models,
runtime and product sources have separate licenses; the starter weights are
Apache 2.0 and Ollama is MIT. Mike remains AGPL-3.0.

Use short tasks and source excerpts. The 8K context also includes Mike's instructions,
tools and response, so it is not an 8K document allowance. Small local models can
miss facts, mishandle tools and perform poorly on complex reasoning. The synthetic
three-fact extraction check measures only that sample and this Mac's response time
and throughput. It is not a legal benchmark or a comparison with Harvey, Legora or
frontier models. A passed check cannot establish fitness for client work.

## Ownership and the commercial path

Free local use should stand on its own. Store work locally, inspect the source,
measure the model, and improve instructions and document context first. The
**Build toward your firm's own AI** guide exports a deployment brief with device,
model and synthetic-check results only—no chats, source documents, keys or paths.
It helps scope paid setup/support, a larger model on firm infrastructure, and
eventual supervised fine-tuning from evidence rather than a mandatory hardware purchase.

This release does not automatically train on conversations. Conversations, memory,
retrieval and fine-tuning are different mechanisms. Firms should approve correction
examples, keep held-out evaluations and establish permission/retention rules before
training. A future service should deliver exportable datasets, adapters/weights,
evaluation results and deployment recipes into the firm's infrastructure under the
applicable licenses. Training jobs and a firm deployment control plane are not
implemented by this Mac starter branch.

## Runtime and supply chain

`src/local/model-catalog.js` pins the official runtime archive's size/SHA-256 and
each approved model's registry manifest digest. Packaging verifies the runtime
before extraction, preserves its sibling native libraries and license notices,
and includes it under `local-stack/bin/ollama`. Model weights remain outside the
signed application. Mutable upstream tags that no longer match the reviewed
digest fail closed and require a catalog update.

The runtime listens only on `127.0.0.1:42816`, uses an app-owned model directory,
has cloud inference disabled, and loads at most one model with one parallel
request. It refuses an occupied port instead of attaching to another daemon.
Privileged install/cancel/export IPC accepts only bundled shell pages in the main
frame. The product gets only a read-only ready-model identifier in local mode.
The backend disables starter thinking and defaults sampling to temperature zero
only for the explicitly managed tag and a loopback endpoint. Explicit temperature
overrides remain supported. With external research off, ordinary and project
chat use a compact instruction preset; the tools, permissions, citation parser
and document trust boundaries remain unchanged. Other providers and the Word
add-in's replacement policy retain their behavior. See the
[native validation results](local-model-validation.md) for why this preset exists.

## Build and release

```sh
npm ci --prefix desktop
npm run local:fetch --prefix desktop
npm run local:build --prefix desktop
npm run local:stage --prefix desktop
npm run dist:local --prefix desktop
```

`local:fetch` downloads build dependencies and the pinned inference runtime.
`local:build` bundles workflows and builds the app with reporting disabled. Nothing
downloads model weights during a base build. The signed release configuration
includes every nested native binary and enforces Apple Silicon/macOS 14+.
Public releases must use `dist:local:signed` with signing/notarization credentials
and pass Gatekeeper verification. An unsigned developer `.app` is not a public
download-and-run release.

```sh
npm test --prefix desktop
npm run e2e:local --prefix desktop
node desktop/e2e/model-onboarding.e2e.mjs
node desktop/e2e/model-smoke.mjs # opt-in: downloads the real starter into disposable test data
```

Before public release, test a freshly downloaded signed DMG on a separate Mac,
offline relaunch with installed weights, interrupted download recovery, first
chat and one document/tool task, app updates preserving data, and an 8 GB Mac
under ordinary memory pressure.

Sources: [Ollama v0.34.3](https://github.com/ollama/ollama/releases/tag/v0.34.3),
[Mac requirements](https://docs.ollama.com/macos),
[Qwen 2B](https://ollama.com/library/qwen3.5:2b),
[Qwen 4B](https://ollama.com/library/qwen3.5:4b).
