import { describe, expect, it } from "vitest";
import {
  uploadSessionRateLimitConfiguration,
  validateRuntimeConfiguration,
} from "../runtimeConfig";

const validProduction = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  SUPABASE_SECRET_KEY: "service-role-key",
  FRONTEND_URL: "https://app.example.test",
  API_PUBLIC_URL: "https://app.example.test/api",
} as NodeJS.ProcessEnv;

describe("runtime authentication configuration", () => {
  it("accepts a complete production configuration", () => {
    expect(() => validateRuntimeConfiguration(validProduction)).not.toThrow();
  });

  it("rejects insecure production callback configuration", () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...validProduction,
        FRONTEND_URL: "http://app.example.test",
        API_PUBLIC_URL: "http://app.example.test/api",
      }),
    ).toThrow(/FRONTEND_URL must use https in production/);
  });

  it("requires a handoff encryption secret when Word auth is enabled", () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...validProduction,
        WORD_ADDIN_URL: "https://word.example.test",
      }),
    ).toThrow(/AUTH_HANDOFF_ENCRYPTION_SECRET is required/);
  });

  it("accepts the legacy anon key name for the user-session client", () => {
    expect(() =>
      validateRuntimeConfiguration({
        ...validProduction,
        SUPABASE_PUBLISHABLE_KEY: undefined,
        SUPABASE_ANON_KEY: "legacy-anon-key",
      }),
    ).not.toThrow();
  });
});

describe("upload-session rate-limit configuration", () => {
  it("uses safe defaults when overrides are absent or invalid", () => {
    expect(
      uploadSessionRateLimitConfiguration({
        RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX: "0",
        RATE_LIMIT_UPLOAD_SESSION_POLL_MAX: "not-a-number",
      }),
    ).toEqual({
      mutationWindowMinutes: 15,
      mutationMax: 300,
      pollingWindowMinutes: 15,
      pollingMax: 3_000,
      sessionCreationMaxPerHour: 50,
    });
  });

  it("accepts positive environment overrides", () => {
    expect(
      uploadSessionRateLimitConfiguration({
        RATE_LIMIT_UPLOAD_SESSION_MUTATION_WINDOW_MINUTES: "10",
        RATE_LIMIT_UPLOAD_SESSION_MUTATION_MAX: "900",
        RATE_LIMIT_UPLOAD_SESSION_POLL_WINDOW_MINUTES: "20",
        RATE_LIMIT_UPLOAD_SESSION_POLL_MAX: "6000",
        RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR: "250",
      }),
    ).toEqual({
      mutationWindowMinutes: 10,
      mutationMax: 900,
      pollingWindowMinutes: 20,
      pollingMax: 6_000,
      sessionCreationMaxPerHour: 250,
    });
  });
});
