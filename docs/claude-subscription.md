# Claude subscription (Claude Code) models

Mike can run Claude models on your own Claude Pro or Max subscription instead
of an Anthropic API key. The backend ships with the Claude Code CLI (through
the Claude Agent SDK). Each request starts a short-lived `claude` process that
signs in with a subscription token.

This is intended for a **single-user, local deployment**. The token belongs to
your personal Claude account, so do not enable it on a server other people use.

## What you get

| Model id | Label in Mike | Used for |
| --- | --- | --- |
| `claude-code/opus` | Claude Opus (subscription) | Chat: complex review and drafting |
| `claude-code/sonnet` | Claude Sonnet (subscription) | Chat and tabular review |
| `claude-code/haiku` | Claude Haiku (subscription) | Chat titles and lightweight tasks |

These models support the same features as the API-key Claude models:

- document reading, search and editing
- generating DOCX, XLSX and PPTX files
- workflows
- CourtListener research
- citations
- the Word add-in
- tabular review
- memory
- streamed reasoning, with the reasoning level control mapped to Claude's
  effort setting

## Setup (Docker Compose)

1. Install Claude Code on your own machine and log in with the account that has
   the subscription:

   ```bash
   npm install -g @anthropic-ai/claude-code   # or: curl -fsSL https://claude.ai/install.sh | bash
   claude   # then run /login and choose your Claude.ai account
   ```

2. Create a long-lived subscription token. This opens a browser to authorize
   and prints a token that starts with `sk-ant-oat01-`:

   ```bash
   claude setup-token
   ```

3. Copy the environment templates if you have not already (see the
   [README quick start](../README.md#quick-start)), then add these lines to
   `backend/.env`:

   ```bash
   CLAUDE_CODE_ENABLED=true
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
   ```

   You can leave `ANTHROPIC_API_KEY` empty. The Claude Code process never
   receives it, so subscription requests are not billed to an API key.

4. Build and start the stack:

   ```bash
   docker compose up --build -d
   ```

5. Open <http://localhost:3000>, sign in, and choose a **(subscription)** model
   from the model picker. To make subscription models the defaults for
   everything, also select them under **Settings → Models** for the title,
   tabular review and memory models.

To change the token later, edit `backend/.env` and run
`docker compose up -d backend`.

## Setup (backend running on the host)

When you run the backend with `npm run dev --prefix backend`, you can skip the
token: the bundled CLI reuses your existing `claude` login. Set only
`CLAUDE_CODE_ENABLED=true` in `backend/.env`. A token set in
`CLAUDE_CODE_OAUTH_TOKEN` takes precedence over that login.

## Verify

Check that the backend can reach your subscription:

```bash
docker compose exec -T backend node -e \
  'require("./dist/lib/llm").completeText({model:"claude-code/haiku",user:"Say OK"}).then(console.log,e=>{console.error(e.message);process.exit(1)})'
```

It should print `OK`. `Not logged in · Please run /login` means the token is
missing or was not loaded, so recreate the backend container after you edit
`backend/.env`.

## How it works

- **One adapter:** the `claude-code/` provider lives in
  `backend/src/lib/llm/claudeCode.ts`, behind the same `streamChatWithTools` /
  `completeText` interface as every other provider.
- **Tools stay in Mike:** Mike's tools are passed to Claude Code through an
  in-process MCP server, and each call runs through Mike's normal tool
  dispatcher.
- **Isolation:** Claude Code runs with its built-in tools (Bash, file access,
  web) disabled, no settings, hooks, plugins or `CLAUDE.md` files, and an empty
  working directory. It can use only Mike's tools.
- **Minimal environment:** the subprocess gets a small allowlist of environment
  variables. `CLAUDE_CODE_OAUTH_TOKEN` is forwarded, since it is what
  authenticates the subscription. Mike's own secrets stay out: database,
  storage, and the API keys for the other providers. An inherited
  `ANTHROPIC_API_KEY` is dropped in particular, because Claude Code would bill
  it instead of the subscription.
- **History:** earlier chat turns are replayed to Claude as a text transcript,
  the same text-only history the other providers receive.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_CODE_ENABLED` | `false` | Offers the `claude-code/*` models and allows them to run |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | Subscription token from `claude setup-token` |
| `CLAUDE_CODE_PATH` | bundled binary | Path to a different `claude` executable |
| `CLAUDE_CODE_IDLE_TIMEOUT_MS` | `120000` | Aborts a turn that produces no output for this long. Clamped to 10000-1800000; `0` disables |
| `CLAUDE_CODE_TIMEOUT_MS` | `600000` | Total budget for one turn, however busy it looks. Clamped to 60000-14400000; `0` disables |

## Limits and troubleshooting

- **Usage limits:** requests count against your subscription's usage limits.
  Large tabular reviews make many requests and can use a lot of your allowance.
  If you reach a limit, the chat shows the error Claude Code returns.
- **Latency:** each request starts a new process, which adds about 1 second
  before the first token.
- **Stalled turns:** the provider runs a local process, so there is no socket
  timeout behind it. Two bounds apply. A turn that goes quiet for
  `CLAUDE_CODE_IDLE_TIMEOUT_MS` is aborted; that timer measures silence rather
  than total time, and it stops while one of Mike's tools is running, so long
  turns that keep working are not cut short. A turn that keeps producing output
  or tool calls but never finishes is aborted after `CLAUDE_CODE_TIMEOUT_MS`,
  which silence alone cannot catch. Either way the chat shows an error saying
  which bound was reached. Raise the idle value if you see spurious timeouts on
  very slow hardware, and the total value if you run genuinely long reviews.
- **Models missing from the picker:** confirm `CLAUDE_CODE_ENABLED=true` is
  set, recreate the backend, and reload the page.
- **Expired or revoked token:** run `claude setup-token` again and update
  `backend/.env`.
