/**
 * Helpers for specs that require a live LLM turn.
 *
 * Four specs (chat rename, chat delete, project-assistant create+submit, and
 * the critical-path "ask a question" flow) create/populate a chat by sending a
 * message. Mike supports keyless local models through Ollama, but the GitHub
 * Actions job does not provision an Ollama server or pull a model. Its only
 * live model is therefore the Anthropic model enabled by ANTHROPIC_API_KEY.
 * Without that secret, these specs cannot submit a message in CI and would
 * otherwise hang until their timeout.
 *
 * In CI the key is the `ANTHROPIC_API_KEY` repository secret, which
 * `.github/workflows/e2e.yml` exposes both to the backend (backend/.env) and
 * to the Playwright process. Guarding with
 * `test.skip(!hasLlmKey, LLM_SKIP_REASON)` keeps a keyless run (a plain local
 * run without Ollama, or a fork PR with no secret access) green on the other 27
 * specs, while still running — and enforcing — the LLM specs whenever the key
 * is present. Setup steps: docs/e2e-ci.md, "Enable the LLM specs".
 *
 * When the key IS set, the specs' selectClaudeModel helper picks "Claude
 * Sonnet 4.6" in the ModelToggle (see docs/e2e-ci.md, "Model selection"), so
 * the unskipped specs submit against a model this repository actually ships.
 */
export const hasLlmKey = Boolean(process.env.ANTHROPIC_API_KEY);

export const LLM_SKIP_REASON =
    "requires a model key — set the ANTHROPIC_API_KEY secret to run LLM-dependent specs";
