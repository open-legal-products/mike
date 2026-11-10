import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireInstanceAdmin } from "./instanceAdmin";
import { instanceAdminEmails, isInstanceAdmin } from "../lib/instanceAdmin";

function run(userEmail: unknown) {
  const res = {
    locals: { userEmail },
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  const next = vi.fn() as NextFunction;
  requireInstanceAdmin({} as Request, res as unknown as Response, next);
  return { res, next };
}

afterEach(() => vi.unstubAllEnvs());

describe("instance admins", () => {
  it("come only from MIKE_ADMIN_EMAILS, trimmed and case-insensitive", () => {
    vi.stubEnv("MIKE_ADMIN_EMAILS", " Will@Example.com ,amal@example.com,, ");
    expect(instanceAdminEmails()).toEqual(["will@example.com", "amal@example.com"]);
    expect(isInstanceAdmin("WILL@example.com")).toBe(true);
    expect(isInstanceAdmin("someone@example.com")).toBe(false);
  });

  it("never match an empty or unconfirmed address, even with an empty list entry", () => {
    vi.stubEnv("MIKE_ADMIN_EMAILS", ",, ,");
    expect(isInstanceAdmin("")).toBe(false);
    expect(isInstanceAdmin(undefined)).toBe(false);
    vi.stubEnv("MIKE_ADMIN_EMAILS", "");
    expect(isInstanceAdmin("")).toBe(false);
  });

  it("answers 403 instance_admin_required for everyone else", () => {
    vi.stubEnv("MIKE_ADMIN_EMAILS", "will@example.com");
    const denied = run("amal@example.com");
    expect(denied.res.status).toHaveBeenCalledWith(403);
    expect(denied.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "instance_admin_required" }),
    );
    expect(denied.next).not.toHaveBeenCalled();
    const allowed = run("will@example.com");
    expect(allowed.next).toHaveBeenCalled();
    expect(allowed.res.status).not.toHaveBeenCalled();
  });
});
