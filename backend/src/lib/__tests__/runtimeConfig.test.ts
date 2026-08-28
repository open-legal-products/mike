import { describe, expect, it } from "vitest";
import {
  uploadConversionTimeoutMs,
  uploadJobWallClockMs,
  uploadProcessingConfiguration,
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

  it("clamps an hourly creation limit the database cannot represent", () => {
    expect(
      uploadSessionRateLimitConfiguration({
        RATE_LIMIT_UPLOAD_SESSION_CREATE_MAX_PER_HOUR: "9999999999",
      }).sessionCreationMaxPerHour,
    ).toBe(1_000_000);
  });
});

describe("upload-processing configuration", () => {
  it("uses a four-job pool with at most four active jobs per user by default", () => {
    expect(uploadProcessingConfiguration({})).toEqual({
      concurrency: 4,
      maxRunningPerUser: 4,
    });
  });

  it("accepts positive overrides and keeps the per-user cap within the pool", () => {
    expect(
      uploadProcessingConfiguration({
        UPLOAD_PROCESSING_CONCURRENCY: "8",
        UPLOAD_PROCESSING_MAX_RUNNING_PER_USER: "20",
      }),
    ).toEqual({
      concurrency: 8,
      maxRunningPerUser: 8,
    });
  });

  it("bounds accidental oversized pools", () => {
    expect(
      uploadProcessingConfiguration({
        UPLOAD_PROCESSING_CONCURRENCY: "1000",
      }),
    ).toEqual({
      concurrency: 64,
      maxRunningPerUser: 4,
    });
  });
});

describe("upload worker deadlines", () => {
  it("uses two-minute conversions and a fifteen-minute job budget by default", () => {
    expect(uploadConversionTimeoutMs({})).toBe(120_000);
    expect(uploadJobWallClockMs({})).toBe(900_000);
  });

  it("accepts overrides inside the supported range", () => {
    expect(
      uploadConversionTimeoutMs({ UPLOAD_CONVERT_TIMEOUT_MS: "45000" }),
    ).toBe(45_000);
    expect(uploadJobWallClockMs({ UPLOAD_JOB_WALL_CLOCK_MS: "300000" })).toBe(
      300_000,
    );
  });

  it("clamps overrides that would disable or never reach the deadline", () => {
    expect(uploadConversionTimeoutMs({ UPLOAD_CONVERT_TIMEOUT_MS: "1" })).toBe(
      10_000,
    );
    expect(
      uploadConversionTimeoutMs({ UPLOAD_CONVERT_TIMEOUT_MS: "9999999" }),
    ).toBe(600_000);
    expect(uploadJobWallClockMs({ UPLOAD_JOB_WALL_CLOCK_MS: "1" })).toBe(
      60_000,
    );
    expect(uploadJobWallClockMs({ UPLOAD_JOB_WALL_CLOCK_MS: "9999999999" })).toBe(
      3_600_000,
    );
  });

  it("falls back to the defaults for unparseable values", () => {
    expect(
      uploadConversionTimeoutMs({ UPLOAD_CONVERT_TIMEOUT_MS: "soon" }),
    ).toBe(120_000);
    expect(uploadJobWallClockMs({ UPLOAD_JOB_WALL_CLOCK_MS: "-5" })).toBe(
      900_000,
    );
  });
});
