import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedAdminClient:
  | {
      url: string;
      key: string;
      client: SupabaseClient<any, "public", any>;
    }
  | undefined;

/**
 * Server-side Supabase client using the service role key.
 * Bypasses RLS — only use in API routes after verifying the user.
 */
export function createServerSupabase() {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  }

  if (cachedAdminClient?.url === url && cachedAdminClient.key === key) {
    return cachedAdminClient.client;
  }

  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  cachedAdminClient = { url, key, client };
  return client;
}

/**
 * The service-role client type. Modules across the codebase declare this
 * locally as `type Db = ReturnType<typeof createServerSupabase>`; new code can
 * import it from here instead.
 */
export type Db = ReturnType<typeof createServerSupabase>;
