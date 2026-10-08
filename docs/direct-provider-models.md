# Direct provider models

The curated catalog was checked against provider documentation on 2026-10-07.
It offers current general-purpose text/tool models, with smaller models for
automatic titles and task settings. It does not include image-generation,
audio, embedding, or restricted-access models.

| Provider | Chat and tabular selection | Automatic title model |
| --- | --- | --- |
| Anthropic | Claude Fable 5.1, Opus 5.5, Sonnet 5.5 | Claude Haiku 4.5 |
| Google | Gemini 3.8 Flash, Gemini 3.1 Pro (Preview) | Gemini 3.5 Flash-Lite |
| OpenAI | GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna | GPT-6 Luna |
| Mistral AI | Mistral Large 4 (Preview), Medium 3.5, Small 4 | Mistral Small 4 |

Main chat still requires an explicit model selection. Internal Gemini fallbacks
use 3.8 Flash. A saved title-model override continues to take precedence.

## Mistral setup

Create an API key in [Mistral Studio](https://console.mistral.ai/), then save it
under Settings → Bring Your Own Keys → Mistral AI API Key. Self-hosted deployments
can instead set `MISTRAL_API_KEY` in `backend/.env`. Personal keys override the
deployment key; removing a personal key restores the environment fallback.

Before deploying this version to an existing database, apply
`backend/migrations/20261007_01_add_mistral_user_api_key_provider.sql` using the
normal [deployment procedure](deployment.md). Fresh installs use the updated
`backend/schema.sql`. The migration only extends the existing provider constraint;
encrypted storage, ownership checks, and RLS are unchanged.

Mistral requests use the native `@ai-sdk/mistral` adapter at
`https://api.mistral.ai/v1`. Streaming, tool calls, tool results, and reasoning
blocks use the existing shared AI SDK loop. The available reasoning controls are
None and High. The API IDs are `mistral-large-4`, `mistral-medium-3-5`, and
`mistral-small-2603`. Large 4 is currently a public preview, labeled accordingly.

## Saved selections

Removed direct-provider IDs are normalized when read, including saved chat,
profile, and task selections. No historical chat records are rewritten.

| Previous selection | Replacement |
| --- | --- |
| Claude Fable 5 | Claude Fable 5.1 |
| Claude Opus 5, 4.8, 4.7 | Claude Opus 5.5 |
| Claude Sonnet 5, 4.6 | Claude Sonnet 5.5 |
| Gemini 3.7, 3.6, 3.5 Flash; 3 Flash Preview | Gemini 3.8 Flash |
| Gemini 3.1 Flash-Lite, including preview ID | Gemini 3.5 Flash-Lite |
| GPT-5.6 Sol | GPT-6 Astra |
| GPT-5.6 Terra, GPT-5.5, GPT-5.4 | GPT-6.1 Sol |
| GPT-5.6 Luna, GPT-5.4 Mini/Lite | GPT-6 Luna |

Replacement models may have different pricing and output behavior. Users can
change their selections in the model picker and task settings. GPT-6 Astra and
GPT-6.1 Sol require reasoning, so a saved None setting is normalized to Low.
Current Fable and Opus also require thinking. Sonnet's lowest setting uses the
SDK's `between_tools` behavior. Lightweight automatic titles use their provider's
small model with reasoning disabled.

OpenRouter and Vercel continue to use their live catalogs and users' saved
allowlists. OpenCode Go retains its protocol compatibility list. Ollama models
remain dynamically discovered. These IDs are not rewritten by the direct-model
mappings.

## Catalog maintenance

Keep `backend/src/lib/llm/models.ts`, the web `ModelToggle.tsx`, and the Word
add-in's `modelCatalog.ts` synchronized, including legacy mappings. Update
reasoning capabilities in the backend and shared `ModelToggleUI.tsx` together.

Sources:

- [Anthropic models](https://platform.claude.com/docs/en/models/overview)
- [Claude thinking compatibility](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [OpenAI models](https://developers.openai.com/api/docs/models)
- [GPT-6 migration](https://developers.openai.com/api/docs/guides/latest-model)
- [Mistral models](https://docs.mistral.ai/models)
- [Mistral Large 4](https://docs.mistral.ai/models/mistral-large-4-0)
- [Mistral Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04)
- [Mistral Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03)
- [Mistral AI SDK adapter](https://ai-sdk.dev/providers/ai-sdk-providers/mistral)
