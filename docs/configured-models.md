# Declaring OpenAI-compatible models

Mike ships with a static catalog of hosted models (Anthropic, Google, OpenAI)
and accepts router-prefixed ids for OpenRouter, the Vercel AI Gateway and
OpenCode Go. A deployment that also runs a self-hosted or third-party
OpenAI-compatible endpoint declares it with `MIKE_MODEL_CONFIG_JSON`, without
a code change.

## Configuration

Set `MIKE_MODEL_CONFIG_JSON` on the backend to a JSON object with a `models`
array:

```json
{
  "models": [
    {
      "id": "local-qwen",
      "label": "Local Qwen 3",
      "provider": "openai-compatible",
      "location": "local",
      "apiModel": "qwen3-32b",
      "baseUrl": "http://localhost:8000/v1"
    },
    {
      "id": "cloud-deepseek",
      "label": "DeepSeek",
      "provider": "openai-compatible",
      "location": "cloud",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The id Mike uses everywhere: model pickers, stored preferences, committee members. |
| `provider` | yes | Must be `openai-compatible`. Hosted providers are already covered by the static catalog and the router prefixes. |
| `location` | yes | `local` or `cloud`. Also the default for tool-call tolerance (below). |
| `label` | no | Display name. Defaults to the id. |
| `apiModel` | no | Model name to send upstream, when it differs from `id`. |
| `baseUrl` | yes | The endpoint's OpenAI-compatible base URL. |
| `apiKey` | no | Literal key. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | no | Environment variable holding the key. |
| `apiKeyProvider` | no | Use the requesting user's saved key for that provider. |
| `tolerateTextToolCalls` | no | Override the tolerance default. |
| `maxTokensField` | no | Output-token request field: `max_tokens` (default) or `max_completion_tokens`. |
| `replayReasoning` | no | Send each earlier assistant turn's stored reasoning back as `reasoning_content`. Default `false`. See [Reasoning replay](#reasoning-replay). |

An entry that declares no key at all is treated as needing none, regardless of
whether its location is `local` or `cloud`. When a key source is declared but
does not resolve, the model is omitted from the authenticated model catalog
until that key becomes available.

`baseUrl` must be an absolute HTTP or HTTPS URL without embedded credentials,
a query string, or a fragment. Optional string and boolean fields are also
type-checked. Malformed entries are dropped; invalid JSON fails loudly when
the registry is first loaded.

A normal web URL is accepted syntactically, but it only works if that address
serves an OpenAI-compatible API. For example, a base URL ending in `/v1` must
accept the usual chat-completions requests; the public homepage of a model
provider is not enough.

Usable declarations are returned by `GET /models/configured` and appear in the
chat, tabular-review, and model-preference selectors. The response contains
only display metadata; endpoint URLs and credentials remain server-side.

Declared models are served through the same AI SDK provider layer as
everything else, so they inherit its transport, retries and streaming.

The compatible provider sends the output limit as `max_tokens` by default,
which works with most compatible servers. Some newer OpenAI models reject that
field and require `max_completion_tokens`; opt into that request shape for the
configured model:

```json
{
  "id": "custom-openai",
  "provider": "openai-compatible",
  "location": "cloud",
  "apiModel": "gpt-5.4-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "maxTokensField": "max_completion_tokens"
}
```

## Tool-call tolerance

Self-hosted builds of Qwen, DeepSeek and GLM often describe tool calls in
prose rather than emitting them as structured tool calls, and wrap their
reasoning in `<think>` tags. Models whose `location` is `local` are therefore
wrapped in a middleware that:

- routes `<think>` prose to the reasoning channel instead of visible text,
- suppresses tool markup in the visible text, and
- converts described tool calls — JSON in `<tool_call>` markers, XML-ish
  `<function=name>` blocks, DeepSeek DSML invocations, and single-key maps —
  into real tool calls, repairing malformed JSON where it can.

A tolerant model answering a request that declares tools is served through the
endpoint's non-streaming path, because these models interleave markup with
prose in a way a partial stream cannot be reassembled from.

Set `tolerateTextToolCalls` explicitly to turn this on for a cloud endpoint
that needs it, or off for a local one that behaves properly.

Set `DEBUG_LLM_TOOL_CALLS=1` to log the raw text of a tool call that could not
be recovered.

## Reasoning replay

Mike sends earlier turns to the model as text only by default. Some
reasoning models are served with a chat template that expects their own
earlier thinking back — for example Qwen3.6 on `llama-server` with
`--chat-template-kwargs '{"preserve_thinking":true}'`. Without it, the model
cannot see why it answered as it did in earlier turns, and it may contradict
or forget decisions it made while thinking.

Set `replayReasoning: true` on such a model:

```json
{
  "id": "local-qwen",
  "provider": "openai-compatible",
  "location": "local",
  "apiModel": "qwen3.6",
  "baseUrl": "http://localhost:8000/v1",
  "replayReasoning": true
}
```

For each earlier assistant message, Mike looks up the stored turn with the same
visible text and sends that turn's reasoning as `reasoning_content`. Messages
that match no stored turn, such as an edited history, are sent as text only. So
is a reply whose text is stored more times than it appears in the history
sent, because Mike cannot tell which of those turns it is.
Reasoning is never taken from the request body. Models without the flag,
including every hosted provider, never receive stored reasoning.

Mike records which model produced each piece of stored reasoning, and replays
only reasoning produced by the model now answering. Switching a chat to another
model never sends it the previous model's thinking. Turns stored before this
recording existed are sent as text only.

Replay is bounded. Only the last 12,000 characters of each turn's reasoning are
sent, and at most 36,000 characters across the whole history, newest turns
first. Once a turn does not fit, it and every older turn are sent as text only.

Within a single turn, the reasoning of each tool-calling step is always passed
to the next step, whatever this setting is.
