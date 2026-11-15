# Image generation

The assistant can create images with the `generate_image` tool. The image is
stored as a generated document (PNG or JPEG, `source = generated`), so it opens
in the document panel, can be downloaded, and in a project chat is attached to
the project like a generated DOCX.

The feature is **off by default**. It is enabled only when `IMAGE_GEN_PROVIDER`
or an explicit `IMAGE_GEN_API_URL` / `IMAGE_GEN_BASE_URL` is set and a key is
available (loopback and Stable Diffusion WebUI endpoints may run keyless).

## Engines

| Engine | Settings |
| --- | --- |
| Local Stable Diffusion WebUI / Forge | `IMAGE_GEN_PROVIDER=automatic1111`, `IMAGE_GEN_BASE_URL=http://127.0.0.1:7860` (start the WebUI with `--api`) |
| OpenAI | `IMAGE_GEN_PROVIDER=openai` (uses `OPENAI_API_KEY` for api.openai.com only), model `gpt-image-1` by default |
| Azure OpenAI | `IMAGE_GEN_PROVIDER=azure`, full deployment URL in `IMAGE_GEN_API_URL`, `AZURE_API_KEY` sent as `api-key` |
| LiteLLM / LocalAI / other OpenAI-compatible | `IMAGE_GEN_PROVIDER=litellm` (or `localai`, `openai-compatible`), `IMAGE_GEN_BASE_URL`, `IMAGE_GEN_API_KEY` |

## Safety boundaries

- A provider's deployment key is sent only to that provider's own host; a
  custom endpoint receives only `IMAGE_GEN_API_KEY`.
- Only inline base64 responses are accepted. A hosted image URL returned by a
  provider is never fetched by the backend (SSRF).
- The bytes must be PNG or JPEG by magic number and below `IMAGE_GEN_MAX_BYTES`.
- Prompts are capped at 4,000 characters, sizes are restricted to
  `IMAGE_GEN_ALLOWED_SIZES`, and failures surface as static
  `image_generation.*` error kinds without the prompt text.
- The tool description tells the model not to place client names,
  confidential facts or personal data in the prompt unless the user asks. For
  matters covered by professional secrecy prefer a local engine.

## Known limitations

- The tool is listed even when the feature is off; it then answers with a
  configuration message, as `search_documents_semantic` does when RAG is off.
- No image editing or inpainting; one image per call.
