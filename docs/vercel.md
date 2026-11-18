# Deploy on Vercel

Mike can run entirely on Vercel, with a Supabase project from the Vercel
Marketplace for the database, sign-in and file storage. There is nothing else
to host, no Docker to install and no keys to copy by hand.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fopen-legal-products%2Fmike&project-name=mike&repository-name=mike&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%2C%22protocol%22%3A%22storage%22%7D%5D&demo-title=Mike&demo-description=Your%20own%20Mike%3A%20the%20open-source%20legal%20AI%20workspace%2C%20on%20your%20Vercel%20account%20with%20a%20Supabase%20database.&demo-url=https%3A%2F%2Fgithub.com%2Fopen-legal-products%2Fmike)

> Vercel's Services, Container runtime and Daemons, which this deployment
> uses, are in beta.

## What the button does

1. Copies the repository into your Git account and creates a Vercel project.
2. Creates a Supabase project through the Marketplace and connects it, which
   gives the project its database, Auth and Storage variables.
3. Builds and deploys the stack described in `vercel.json`:

| Part | Runs as | Source |
|---|---|---|
| Web app | Next.js service `web` | `frontend/` |
| API (`/api/*`) | Container service `api` | `backend/Dockerfile` |
| Background jobs | Daemon `worker` (one instance, `iad1`) | `backend/Dockerfile` |
| Database, Auth, files | Supabase | Marketplace integration |

There is nothing to fill in. Open the production URL when the deployment is
ready: a new deployment has no accounts, so Mike shows **Set up Mike**, where
you create the first account and are signed straight in. That account is
confirmed without an email, because a new Supabase project cannot send one
yet. The screen is offered only while the deployment has no accounts at all,
so open it soon after deploying: whoever opens it first creates the first
account. Setup needs no database table: Mike asks Supabase Auth whether any
account exists. The first account has no special rights.

Then add a model-provider key under **Settings > Bring Your Own Keys**, or set
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` on the Vercel
project and redeploy.

The login page offers Google and SSO only once they are configured (see
below), so a new deployment shows email and password alone.

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
  once and keeps them in the table `mike_deploy.secrets`, in a schema that the
  Supabase API does not expose. That table exists only on Vercel deployments:
  it is created here rather than by a migration, and `backend/schema.sql`
  does not list it. A value you set on the Vercel project takes precedence.
  Do not change `USER_API_KEYS_ENCRYPTION_SECRET` afterwards, and do not drop
  that table: keys users saved under the old value can no longer be read.
- It turns on first-run setup (`MIKE_FIRST_RUN_SETUP=true`). To create the
  first account without the setup screen instead, set `MIKE_ADMIN_EMAIL` and
  `MIKE_ADMIN_PASSWORD` (at least 10 characters) on the project before the
  first deployment; `backend/scripts/vercel-admin-user.mjs` creates it,
  confirmed, and never changes an existing account.

Any variable you set on the Vercel project wins over the derived one, so the
rest of [Environment](deployment.md#environment) applies unchanged.

## Letting other people sign up

A Marketplace Supabase project does not know your deployment's URL, and its
built-in mailer sends only to members of the Supabase project, at most two
messages an hour, so a confirmation email could not reach a new user. Until
you set it up, the sign-up page says sign-up isn't open yet (and the API
refuses sign-ups with the same message), rather than creating accounts that
can never be confirmed. To open it:

1. In Supabase, **Authentication > URL Configuration**: set the Site URL to
   your production URL and add `https://<your-domain>/auth/callback` to the
   redirect URLs.
2. **Authentication > Emails > SMTP Settings**: add your own SMTP provider.
3. On the Vercel project, set `MIKE_SIGNUP_EMAIL_CONFIGURED=true` and
   redeploy.

See [Authentication email](deployment.md#authentication-email) for the
details. To add **Continue with Google**, enable the Google provider in
Supabase as described in [Google authentication](deployment.md#google-authentication);
the button appears on the login page within a minute, with no redeploy.

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
- **Production only.** `vercel.json` deploys only the `main` branch: Daemons
  run only in production and the backend trusts only the production domain,
  and the copy the button makes would otherwise build a preview for every
  Dependabot branch. Dependabot still opens pull requests in your copy;
  disable it under the repository's **Settings > Code security** if you do
  not want them.
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
3. Deploy to production and open the URL to create the first account.

To use an S3-compatible bucket instead of Supabase Storage, set the `R2_*`
variables described in [Environment](deployment.md#environment) and its
[CORS policy](deployment.md#object-storage-cors-for-direct-uploads).
