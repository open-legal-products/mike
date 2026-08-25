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

An entry that declares no key at all is treated as needing none, which is
usually right for a self-hosted endpoint on a private network. Malformed
entries are dropped; invalid JSON fails loudly at startup.

Declared models are served through the same AI SDK provider layer as
everything else, so they inherit its transport, retries and streaming.

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
