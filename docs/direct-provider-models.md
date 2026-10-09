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

## Provider switches

Each provider card in Model Providers shows an on/off switch once a personal
key is saved. Turning a provider off preserves its encrypted key, settings, and
model selections, but makes its models unavailable and blocks requests through
that provider, including fallback to a deployment key. Turning it back on
restores access. Clearing the personal key still restores the environment
fallback.

Existing databases need
`backend/migrations/20261009_02_user_api_key_enabled.sql`. Saved keys start
enabled; fresh installs include the column in `backend/schema.sql`.

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

## Amazon Bedrock and Azure OpenAI setup

Bedrock and Azure OpenAI keys only work together with a second, non-secret
value, so each is saved with it under Settings → Bring Your Own Keys:

| Provider | Key | Saved with |
| --- | --- | --- |
| Amazon Bedrock | A Bedrock API key from the Amazon Bedrock console | The AWS region the key was created in, for example `us-east-1` |
| Azure OpenAI | The resource's API key | The resource name (`contoso-openai`) or its endpoint URL |

Azure endpoints must be `https` URLs on `*.openai.azure.com`,
`*.cognitiveservices.azure.com` or `*.services.ai.azure.com`; the backend
rejects any other host because it sends the key there. Once a key is saved, its
region or endpoint can be changed without re-entering the key.

Self-hosted deployments can instead set `AWS_BEARER_TOKEN_BEDROCK` with
`BEDROCK_AWS_REGION` (falling back to `AWS_REGION`), and `AZURE_API_KEY` with
`AZURE_OPENAI_ENDPOINT` (or `AZURE_RESOURCE_NAME`). A key counts as configured
only when its region or endpoint is also set. A personal key always runs with
its own saved region or endpoint, never the deployment's, and removing it
restores the environment pair.

Neither platform publishes a catalog a key can list, so models are added by ID
in the provider's dialog under Bring Your Own Keys once the key is saved:

- **Bedrock:** model or inference-profile IDs enabled in the account and
  region, such as `us.anthropic.claude-opus-5-5`, `amazon.nova-pro-v1:0`, or an
  inference-profile ARN. Requests use the Converse API through
  `@ai-sdk/amazon-bedrock` with bearer authentication; ambient AWS credentials
  are never used. Claude models get a prompt-cache point on long chats.
- **Azure OpenAI:** deployment names. Requests use the v1 Responses API through
  `@ai-sdk/azure`. Reasoning controls are inferred from the deployment name, so
  a deployment named after its model (`gpt-6.1-sol`) gets them and an
  arbitrary name runs without them.

The app-level model IDs are `bedrock/<model-id>` and `azure/<deployment>`. As
with other routers, a request can only use a model in the requesting user's
saved list. Before deploying this version to an existing database, apply
`backend/migrations/20261008_03_bedrock_azure_user_api_keys.sql`; it extends the
provider constraint and adds the nullable `settings` column that holds the
region or endpoint. Encrypted key storage, ownership checks and RLS are
unchanged.

## Google Vertex AI, Azure AI Foundry, xAI and custom endpoints

Four more providers are saved under Settings → Bring Your Own Keys. Three of
them pair the key with a non-secret value, like Bedrock and Azure OpenAI:

| Provider | Key | Saved with |
| --- | --- | --- |
| Google Vertex AI | The full contents of a service-account key file (JSON) | The Vertex AI location, for example `us-central1` or `global` |
| Azure AI Foundry | The Foundry resource's API key | The resource name (`contoso-foundry`) or its endpoint URL |
| xAI | An xAI API key | — |
| OpenAI-compatible endpoint | The endpoint's API key | Its base URL, for example `https://llm.example.com/v1` |

Self-hosted deployments can instead set `GOOGLE_VERTEX_CREDENTIALS_JSON` with
`GOOGLE_VERTEX_LOCATION`, `AZURE_FOUNDRY_API_KEY` with
`AZURE_FOUNDRY_ENDPOINT`, and `XAI_API_KEY`. A custom endpoint has no
environment form: deployments declare shared endpoints in
`MIKE_MODEL_CONFIG_JSON`. As elsewhere, a personal key runs only with its own
saved setting.

Models are added per provider once the key is saved. The app-level IDs are
`vertex/<model-id>`, `azure-foundry/<deployment>`, `xai/<model>` and
`custom/<model>`, and a request can only use a model in the requesting user's
saved list.

- **Vertex AI:** the service account needs the Vertex AI User role, and the
  project is read from the key file's `project_id`. A model ID selects the
  protocol: `claude…` IDs (`claude-opus-5-5@20260101`) use Anthropic Messages,
  `publisher/model` IDs (`meta/llama-4-maverick-maas`) use the
  OpenAI-compatible partner-model endpoint, and anything else is sent to the
  Gemini API. Access tokens are minted from the key's email and private key
  only and cached per key; the file's `token_uri` is ignored, and neither
  ambient Google credentials nor a `GOOGLE_VERTEX_API_KEY` in the environment
  is ever used. Models are typed by ID.
- **Azure AI Foundry:** deployment names of non-OpenAI models. A deployment
  whose name contains `claude` is called over Anthropic Messages at
  `/anthropic/v1`; every other deployment is called over Chat Completions at
  `/openai/v1`, without reasoning controls. Rename-proofing is not possible
  with an API key, so keep `claude` in the name of Claude deployments. OpenAI
  deployments belong under Azure OpenAI, which uses the Responses API.
- **xAI:** the model list is read live from `https://api.x.ai/v1/models`, with
  image, video and voice models filtered out. Requests use `@ai-sdk/xai`.
- **OpenAI-compatible endpoint:** any service that implements
  `POST {base URL}/chat/completions`, such as a LiteLLM proxy, vLLM, Groq,
  Together, Fireworks or DeepSeek. The model list is read from
  `GET {base URL}/models` when the endpoint offers one; otherwise IDs are
  typed. Because the backend sends requests and the key to a URL the user
  chose, the URL must be public `https`, and every request goes through the
  same guarded fetch as custom MCP connectors: loopback, private, link-local
  and cloud-metadata addresses are refused, including when a public name
  resolves to one. Endpoints on a private network belong in
  `MIKE_MODEL_CONFIG_JSON`.

Vertex AI and Foundry infer the protocol from the model or deployment name.
When a name does not reveal it, save the ID with an explicit protocol:
`anthropic:<name>` for Anthropic Messages, `openai:<name>` for Chat
Completions (the partner-model endpoint on Vertex), or `gemini:<name>` for the
Gemini API on Vertex. The prefix selects the protocol and is not sent upstream;
for example a Foundry Claude deployment named `prod-sonnet` is saved as
`anthropic:prod-sonnet`.

Before deploying this version to an existing database, apply
`backend/migrations/20261009_01_vertex_foundry_xai_custom_user_api_keys.sql`,
which extends the provider constraint. Encrypted key storage, ownership checks
and RLS are unchanged.

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
