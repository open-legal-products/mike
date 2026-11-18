# Deploy on Vercel

Mike can run entirely on Vercel, with a Supabase project from the Vercel
Marketplace for the database, sign-in and file storage. There is nothing else
to host, no Docker to install and no keys to copy by hand.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fopen-legal-products%2Fmike&project-name=mike&repository-name=mike&env=MIKE_ADMIN_EMAIL%2CMIKE_ADMIN_PASSWORD&envDescription=The%20email%20and%20password%20%28at%20least%2010%20characters%29%20of%20the%20first%20Mike%20account%2C%20created%20for%20you%20on%20first%20start&envLink=https%3A%2F%2Fgithub.com%2Fopen-legal-products%2Fmike%2Fblob%2Fmain%2Fdocs%2Fvercel.md&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%7D%5D)

> Vercel's Services, Container runtime and Daemons, which this deployment
> uses, are in beta.

## What the button does

1. Copies the repository into your Git account and creates a Vercel project.
2. Creates a Supabase project through the Marketplace and connects it, which
   gives the project its database, Auth and Storage variables.
3. Asks for `MIKE_ADMIN_EMAIL` and `MIKE_ADMIN_PASSWORD` (at least 10
   characters). That account is created, already confirmed, the first time the
   backend starts, so you can sign in as soon as the deployment is ready.
4. Builds and deploys the stack described in `vercel.json`:

| Part | Runs as | Source |
|---|---|---|
| Web app | Next.js service `web` | `frontend/` |
| API (`/api/*`) | Container service `api` | `backend/Dockerfile` |
| Background jobs | Daemon `worker` (one instance, `iad1`) | `backend/Dockerfile` |
| Database, Auth, files | Supabase | Marketplace integration |

Open the production URL and sign in with the admin email and password. Add
a model-provider key under **Settings > Bring Your Own Keys**, or set
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` on the Vercel
project and redeploy.

## What happens on start

`backend/scripts/vercel-start.sh` runs before the API and the worker. Each
step is idempotent:

- It reads the Supabase integration's variables (`SUPABASE_URL`,
  `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`,
  `POSTGRES_URL_NON_POOLING`) and derives `FRONTEND_URL` and `API_PUBLIC_URL`
  from the project's production domain (`VERCEL_PROJECT_PRODUCTION_URL`).
- On a new database it loads `backend/schema.sql`; then it applies any pending
  migration with `backend/scripts/migrate.sh`. A redeploy of a newer Mike
  migrates the database the same way.
- It creates the private `mike` Storage bucket and selects the Supabase
  Storage driver (`STORAGE_DRIVER=supabase`), unless `R2_ENDPOINT_URL` is set.
- It generates `DOWNLOAD_SIGNING_SECRET` and `USER_API_KEYS_ENCRYPTION_SECRET`
  once and keeps them in the `mike_deploy` schema, which the Supabase API does
  not expose. A value you set on the Vercel project takes precedence. Do not
  change `USER_API_KEYS_ENCRYPTION_SECRET` afterwards: keys users saved under
  the old value can no longer be read.
- It creates the admin account (`backend/scripts/vercel-admin-user.mjs`). An
  existing account is never changed, so you can remove
  `MIKE_ADMIN_PASSWORD` from the project after the first sign-in.

Any variable you set on the Vercel project wins over the derived one, so the
rest of [Environment](deployment.md#environment) applies unchanged.

## Letting other people sign up

A Marketplace Supabase project does not know your deployment's URL, and its
built-in mailer sends only to members of the Supabase project, at most two
messages an hour. Before inviting anyone:

1. In Supabase, **Authentication > URL Configuration**: set the Site URL to
   your production URL and add `https://<your-domain>/auth/callback` to the
   redirect URLs.
2. **Authentication > Emails > SMTP Settings**: add your own SMTP provider.

See [Authentication email](deployment.md#authentication-email) and
[Google authentication](deployment.md#google-authentication) for the details.

## Limits

- **Request and response size.** A request body through `/api` is capped at
  4.5 MB. Files never take that path: browsers upload straight to Supabase
  Storage.
- **File size.** The Supabase Free plan stores files up to 50 MB; Mike
  accepts uploads up to 100 MB. Raise the limit on a paid Supabase plan under
  **Storage > Settings**.
- **Long assistant turns.** A streamed response ends when the API reaches its
  maximum duration (300 seconds by default, up to 800 seconds on Pro). An
  interrupted turn resumes when the client reconnects.
- **Background jobs on Hobby.** Daemons on the Hobby plan have a monthly
  quota (about nine days of one instance) and stop until the next month when
  it runs out. The API also processes jobs while it is serving traffic, so
  uploads and reviews keep working, but jobs started just before the API
  scales down wait for the next request. Use Pro for a team.
- **Previews.** Daemons run only in production, and the backend trusts only
  the production domain, so use the production deployment.
- **First request after idle.** The API container stops after five minutes
  without traffic; the next request starts it again, which takes about six
  seconds.
- **Built-in workflows.** The worker loads the workflow catalog from GitHub
  when it starts. GitHub's anonymous API limit is shared by Vercel's outbound
  addresses, so the download can be refused; the worker retries for two
  hours. Set `MIKE_WORKFLOWS_GITHUB_TOKEN` (a token with no scopes is enough)
  to avoid the limit.

## Setting it up by hand

1. Import the repository in Vercel. The framework preset is **Services**,
   detected from `vercel.json`; leave the root directory at the repository
   root.
2. In the project's **Storage** tab, create or connect a Supabase database
   for all environments.
3. Add `MIKE_ADMIN_EMAIL` and `MIKE_ADMIN_PASSWORD`, then deploy to
   production.

To use an S3-compatible bucket instead of Supabase Storage, set the `R2_*`
variables described in [Environment](deployment.md#environment) and its
[CORS policy](deployment.md#object-storage-cors-for-direct-uploads).
