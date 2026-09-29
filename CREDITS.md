# Open-source credits

Mike is built with the work of open-source maintainers and contributors. Thank
you for making these projects available and for the care that goes into them.

This page highlights the projects behind Mike's document tools, applications,
infrastructure, and development workflow, including optional local integrations.

## Documents and spreadsheets

| Project | How Mike uses it |
| --- | --- |
| [LibreOffice](https://www.libreoffice.org/) | Server-side office-document conversion, including PDF renditions. |
| [libreoffice-convert](https://github.com/elwerene/libreoffice-convert) | Node.js integration with LibreOffice's conversion tools. |
| [PDF.js](https://github.com/mozilla/pdf.js) | PDF viewing in the browser and PDF text extraction on the backend through `pdfjs-dist`. |
| [EigenPal DOCX Editor](https://github.com/eigenpal/docx-editor) | Browser-based Word document viewing and editing through `@docx-editor.dev/core`, `@docx-editor.dev/react`, and the packaged fonts. |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) | Extracting content from Word documents. |
| [docx](https://github.com/dolanmiu/docx) | Creating Word documents. |
| [FortuneSheet](https://github.com/ruilisi/fortune-sheet) | Interactive spreadsheet viewing and editing. |
| [LuckyExcel](https://github.com/dream-num/Luckyexcel) | Importing Excel workbooks into the spreadsheet viewer. |
| [SheetJS Community Edition](https://git.sheetjs.com/sheetjs/sheetjs) | Reading and processing spreadsheet data on the backend. |
| [ExcelJS](https://github.com/exceljs/exceljs) | Building Excel workbook exports. |
| [JSZip](https://github.com/Stuk/jszip) | Reading and writing ZIP-based document packages. |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | Parsing document XML. |

## Application and interface

| Project | How Mike uses it |
| --- | --- |
| [Node.js](https://nodejs.org/) | JavaScript runtime for the backend and application tooling. |
| [TypeScript](https://www.typescriptlang.org/) | Typed application code across the web app, backend, and Word add-in. |
| [React](https://react.dev/) | User interfaces for the web app and Word add-in. |
| [Next.js](https://nextjs.org/) | Web application framework. |
| [Express](https://expressjs.com/) | Backend HTTP API. |
| [Tailwind CSS](https://tailwindcss.com/) | Shared styling and design tokens. |
| [shadcn/ui](https://ui.shadcn.com/) and [Radix Primitives](https://www.radix-ui.com/primitives) | Reusable interface components and accessible interactions. |
| [Lucide](https://lucide.dev/) | Interface icons. |
| [Tiptap](https://github.com/ueberdosis/tiptap) and [ProseMirror](https://prosemirror.net/) | Rich-text editing in the web app and Word add-in. |
| [react-markdown](https://github.com/remarkjs/react-markdown), [remark](https://github.com/remarkjs/remark), and [rehype](https://github.com/rehypejs/rehype) | Rendering Markdown, tables, and formatted assistant responses. |
| [Marked](https://github.com/markedjs/marked) | Markdown parsing. |
| [KaTeX](https://katex.org/) | Mathematical notation. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Sanitizing HTML content. |
| [Recharts](https://recharts.org/) | Charts and data visualization. |

## AI, data, and infrastructure

| Project | How Mike uses it |
| --- | --- |
| [AI SDK](https://github.com/vercel/ai) | Language-model integrations, streaming, and tool calls. |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Connections to MCP tools and servers. |
| [Ollama](https://github.com/ollama/ollama) | Optional local language-model inference. |
| [Zod](https://github.com/colinhacks/zod) | Runtime schema validation. |
| [PostgreSQL](https://www.postgresql.org/) | Persistent application data. |
| [Supabase](https://github.com/supabase/supabase) and [Supabase Auth](https://github.com/supabase/auth) | Database tooling, authentication, and client libraries. |
| [PostgREST](https://github.com/PostgREST/postgrest) | REST access to PostgreSQL in the local stack. |
| [Redis](https://github.com/redis/redis), [BullMQ](https://github.com/taskforcesh/bullmq), and [ioredis](https://github.com/redis/ioredis) | Background queues and their Redis transport. |
| [RustFS](https://github.com/rustfs/rustfs) | S3-compatible object storage in the local stack. |
| [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) | Access to S3-compatible document storage. |
| [NGINX](https://github.com/nginx/nginx) | Gateway routing in the local stack. |
| [Mailpit](https://github.com/axllent/mailpit) | Capturing email during local development. |
| [Sentry JavaScript SDKs](https://github.com/getsentry/sentry-javascript) | Error reporting across the backend, web app, and Word add-in. |
| [Undici](https://github.com/nodejs/undici) | Backend HTTP requests. |

## Development and testing

| Project | How Mike uses it |
| --- | --- |
| [Vitest](https://vitest.dev/) | Unit and integration tests. |
| [Testing Library](https://testing-library.com/) and [jsdom](https://github.com/jsdom/jsdom) | Component and browser-DOM tests. |
| [Playwright](https://playwright.dev/) | Browser end-to-end tests. |
| [axe-core](https://github.com/dequelabs/axe-core) | Automated accessibility checks. |
| [SuperTest](https://github.com/ladjs/supertest) | HTTP API integration tests. |
| [Stryker](https://stryker-mutator.io/) | Mutation testing. |
| [Ladle](https://ladle.dev/) | Component catalog and isolated UI previews. |
| [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/) | Code quality and formatting tools. |
| [Vite](https://vite.dev/), [webpack](https://webpack.js.org/), and [PostCSS](https://postcss.org/) | Development servers, bundling, and CSS processing. |
| [OpenNext](https://opennext.js.org/) | Cloudflare deployment support for the web app. |
| [Office Add-in tooling](https://github.com/OfficeDev/Office-Addin-Scripts) | Local development and debugging for the Word add-in. |

## Dependency details

We also thank the authors of the many supporting and transitive dependencies
that these projects rely on. This is a curated acknowledgment, rather than a
complete dependency inventory. Direct dependencies are recorded in the
[root](package.json), [frontend](frontend/package.json),
[backend](backend/package.json), and [Word add-in](word-addin/package.json)
package manifests; their lockfiles record resolved JavaScript dependencies.
The [Compose stack](docker-compose.yml) and application Dockerfiles also record
system and service dependencies.

Each third-party project retains its own license and copyright notices. Refer
to the license and notice files distributed with the versions in use. Please
keep this page current when adding or replacing a significant dependency.
