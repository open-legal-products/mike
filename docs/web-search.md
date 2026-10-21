# Web search

The assistant can search the web and read web pages in chats and project
chats. It is off for each user until they turn it on under
**Settings > Features > Web Search**. Tabular review and the Word add-in do not
search the web.

## How searches run

Once web search is on, users choose how each kind of model searches. The
Claude and OpenAI rows appear only when that provider is set up; the last row
covers every other model, or all models when neither is.

| Models | Choices | Default |
| --- | --- | --- |
| Claude | Anthropic Search, a search service, Off | Anthropic Search |
| OpenAI | OpenAI Search, a search service, Off | OpenAI Search |
| Other models | A search service, Off | Off |

- **Anthropic or OpenAI Search**: the provider runs the search and reads the
  pages. The provider bills searches to the API key in use (Anthropic charges
  per search on top of tokens).
- **A search service** (Mike's search): Mike calls the
  [Brave Search](https://brave.com/search/api/),
  [Tavily](https://docs.tavily.com/) or
  [DeepSeek Search](https://api-docs.deepseek.com/guides/search/) API from the
  backend. It works with any model and needs that service's API key. Tavily
  and DeepSeek also read pages for Mike; with Brave, Mike reads pages itself.
- **Off**: those models do not search.

A choice never stands in for another. If a search service is chosen and no
key is available, those models do not search until a key is added or the
choice is changed. The key field appears once a search service is chosen.

Gemini's built-in search is not offered, because Google requires its search
suggestions to be displayed wherever grounded results appear.

Mike asks the provider for at most five searches per request. An answer makes
one request per step, so a long answer can search more than five times, and
OpenAI has no per-request limit. The tool stays offered for the whole answer
because Anthropic rejects a request that drops it after earlier searches. Mike's
search is limited to eight searches per answer.

## Reading pages

Whichever search is chosen, the assistant can also open pages with Mike's
page reader. With Anthropic or OpenAI Search it uses the reader for links the
user gives and for search results it needs in full. With Tavily or DeepSeek,
the service reads the page first (DeepSeek reads no PDFs). Otherwise, or when
the service cannot, the reader fetches the page from this server: HTML pages
are reduced to their main content, and PDFs to their text, including PDFs a
site serves as a generic binary file. Text comes back 20,000 characters at a
time, and the assistant asks for the next part of a long page when it needs
more; a page is fetched once per answer however many parts are read. It opens
at most twelve pages per answer.

[Subagents](subagents.md) have their own search and page limits on top of the
answer's, set by the effort the assistant chooses (at most 60 searches and 100
pages each), and together an answer's subagents make at most 150 searches and
open at most 250 pages. A page already opened in the answer is not fetched
again. At most, one answer makes 158 searches and opens 262 pages.

## Search service keys

Keys come from the same places as model API keys, chosen the same way:

1. The user's own, saved under **Settings > Features > Web Search** while web
   search is on.
2. Their organization's, saved through the organization API keys endpoint
   with provider `brave`, `tavily` or `deepseek`.
3. The deployment's `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY` or
   `DEEPSEEK_SEARCH_API_KEY`, used for everyone without their own key.

Each search asks for up to ten results and is billed by the service to
whichever key is used, as are the pages Tavily and DeepSeek read. Brave
requests made with the same key are spaced a little over a second apart,
because Brave's free plan allows one request per second.

## Safety

- **Private addresses.** Pages are fetched through the same guard as MCP
  connectors: loopback, private, link-local and cloud-metadata addresses are
  refused, at every redirect.
- **Which pages the reader can open.** Only pages a search (Mike's or the AI
  provider's) returned in the same answer, links to the same site on pages it
  has already read, and links in the user's latest message. Text injected
  into a document or a third-party page cannot send the assistant to an
  arbitrary address. A page on an attacker's own site can still steer which
  of its own pages the assistant reads next. Pages the AI provider's search
  opens itself are fetched on the provider's side.
- **Untrusted content.** Search results and page text are fenced as untrusted
  content, the same way document text is, and the assistant is told never to
  follow instructions found in them.
- **Confidentiality.** Queries leave the deployment: they go to the AI
  provider, or to the search service and the sites read. The assistant is
  instructed never to put client names, matter details, personal data or
  document text into a query.

With OpenAI search, OpenAI opens pages on its own servers, outside the
controls on Mike's `read_webpage`. Mike's own network cannot be reached that
way, but Mike's link allowlist and read limits do not apply to those pages.
Choose a search service for models where that control matters.

## Troubleshooting

- *"Web search is unavailable: the chosen search service has no API key set
  up."* Save a key in Settings or set the service's environment variable.
- *"Web search is unavailable: the search service refused the request."* The
  key is invalid, out of credit, or its plan does not cover the request. A
  rate-limited search is reported as not completed instead, and the assistant
  may try again.
- *"Web search is unavailable for this model."* The AI provider refused its
  search tool, for example because web search is not enabled for the
  Anthropic organization or the model does not support it. The answer
  continues without searching.
- Existing deployments must apply the `user_web_search` and
  `web_search_api_keys` migrations from `backend/migrations/` before users can
  save the setting or a search service key.
