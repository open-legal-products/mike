import { afterEach, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";

vi.mock("@sentry/nextjs", () => ({
    init: vi.fn(),
    captureConsoleIntegration: vi.fn(() => ({ name: "CaptureConsole" })),
    captureRouterTransitionStart: vi.fn(),
}));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    vi.resetModules();
});

it.each(["", "true", "false"])("initializes the browser through the runtime tunnel with baked disabled=%s", async (disabled) => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DISABLED", disabled);
    // Even a bad baked DSN must not prevent a valid runtime destination working.
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "invalid-baked-dsn");
    const { onRouterTransitionStart } = await import("./instrumentation-client");
    expect(Sentry.init).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        tunnel: "/monitoring",
        dsn: expect.stringMatching(/^https:\/\//),
    }));
    expect(onRouterTransitionStart).toBe(Sentry.captureRouterTransitionStart);
});
