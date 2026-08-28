function required(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function envInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

// The hourly session ceiling is passed straight into a PostgreSQL integer
// argument, so an oversized override would turn every session create into a
// numeric-overflow failure rather than a looser limit.
const MAX_UPLOAD_SESSIONS_PER_HOUR = 1_000_000;

export function uploadSessionRateLimitConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    mutationWindowMinutes: envInt(
      "RATE_LIMIT_UPLOAD_SESSION_MUTATION_WINDOW_MINUTES",
      15,
      env,
    ),
    mutationMax: envInt("RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX", 300, env),
    pollingWindowMinutes: envInt(
      "RATE_LIMIT_UPLOAD_SESSION_POLL_WINDOW_MINUTES",
      15,
      env,
    ),
    pollingMax: envInt("RATE_LIMIT_UPLOAD_SESSION_POLL_MAX", 3_000, env),
    sessionCreationMaxPerHour: clamp(
      envInt("RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR", 50, env),
      1,
      MAX_UPLOAD_SESSIONS_PER_HOUR,
    ),
  };
}

export function uploadProcessingConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  const concurrency = Math.min(
    envInt("UPLOAD_PROCESSING_CONCURRENCY", 4, env),
    64,
  );
  return {
    concurrency,
    maxRunningPerUser: Math.min(
      envInt("UPLOAD_PROCESSING_MAX_RUNNING_PER_USER", 4, env),
      concurrency,
    ),
  };
}

/**
 * Hard deadline for one LibreOffice conversion. A wedged `soffice` child would
 * otherwise hold its worker slot for the life of the process.
 */
export function uploadConversionTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return clamp(
    envInt("UPLOAD_CONVERT_TIMEOUT_MS", 120_000, env),
    10_000,
    600_000,
  );
}

/**
 * Wall-clock budget for one upload job. Past this point the worker stops
 * renewing its lease so another worker can steal and retry the job.
 */
export function uploadJobWallClockMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return clamp(
    envInt("UPLOAD_JOB_WALL_CLOCK_MS", 15 * 60_000, env),
    60_000,
    60 * 60_000,
  );
}

function parsedUrl(value: string, name: string, errors: string[]): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${name} must use http or https`);
      return null;
    }
    return url;
  } catch {
    errors.push(`${name} must be an absolute URL`);
    return null;
  }
}

function requireHttps(url: URL | null, name: string, errors: string[]) {
  if (url && url.protocol !== "https:") {
    errors.push(`${name} must use https in production`);
  }
}

export function supabaseSessionConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    url: required(env, ["SUPABASE_URL"]),
    key: required(env, ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]),
  };
}

export function configuredApiPublicUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return required(env, ["API_PUBLIC_URL"]).replace(/\/+$/, "");
}

export function authHandoffEncryptionSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = env.AUTH_HANDOFF_ENCRYPTION_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error(
      "AUTH_HANDOFF_ENCRYPTION_SECRET must contain at least 32 characters",
    );
  }
  return secret;
}

/**
 * Fail before the HTTP listener starts when the authentication boundary is not
 * usable. This deliberately lives outside app.ts so unit tests can import the
 * Express app without supplying production credentials.
 */
export function validateRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const errors: string[] = [];
  const session = supabaseSessionConfiguration(env);

  if (!session.url) errors.push("SUPABASE_URL is required");
  if (!session.key) {
    errors.push("SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) is required");
  }
  if (!env.SUPABASE_SECRET_KEY?.trim()) {
    errors.push("SUPABASE_SECRET_KEY is required");
  }

  if (session.url) parsedUrl(session.url, "SUPABASE_URL", errors);

  if (env.AUTH_HANDOFF_ENCRYPTION_SECRET?.trim()) {
    if (env.AUTH_HANDOFF_ENCRYPTION_SECRET.trim().length < 32) {
      errors.push(
        "AUTH_HANDOFF_ENCRYPTION_SECRET must contain at least 32 characters",
      );
    }
  } else if (env.WORD_ADDIN_URL?.trim()) {
    errors.push(
      "AUTH_HANDOFF_ENCRYPTION_SECRET is required when WORD_ADDIN_URL is set",
    );
  }

  if (env.NODE_ENV === "production") {
    const frontend = env.FRONTEND_URL?.trim();
    if (!frontend) {
      errors.push("FRONTEND_URL is required in production");
    } else {
      requireHttps(
        parsedUrl(frontend, "FRONTEND_URL", errors),
        "FRONTEND_URL",
        errors,
      );
    }

    const publicApi = configuredApiPublicUrl(env);
    if (!publicApi) {
      errors.push("API_PUBLIC_URL is required in production");
    } else {
      requireHttps(
        parsedUrl(publicApi, "API_PUBLIC_URL", errors),
        "API_PUBLIC_URL",
        errors,
      );
    }

    const wordAddin = env.WORD_ADDIN_URL?.trim();
    if (wordAddin) {
      requireHttps(
        parsedUrl(wordAddin, "WORD_ADDIN_URL", errors),
        "WORD_ADDIN_URL",
        errors,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Backend authentication configuration is invalid:\n- ${errors.join("\n- ")}`,
    );
  }
}
