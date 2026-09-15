import { describe, expect, it } from "vitest";
import { findAssignableOrgMember } from "../orgAccessOverrides";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";

describe("organization override target shared by projects and workflows", () => {
  it("normalizes the email and scopes membership to the resource's organization", async () => {
    const fake = scriptedDb([
      { table: "user_profiles", data: { user_id: "target" } },
      { table: "org_members", data: { role: "member" } },
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        " Person@Example.com ",
        "creator",
      ),
    ).toEqual({
      ok: true,
      member: {
        userId: "target",
        email: "person@example.com",
        orgRole: "member",
      },
    });
    expect(fake.calls[0].filters).toEqual([
      ["eq", "email", "person@example.com"],
    ]);
    expect(fake.calls[1].filters).toEqual([
      ["eq", "org_id", "org"],
      ["eq", "user_id", "target"],
    ]);
    fake.done();
  });
  it.each([
    ["creator", "member", "The creator is always an owner"],
    ["creator", "admin", "The creator is always an owner"],
    ["someone", "admin", "Organization admins always have owner access"],
  ])("protects %s with org role %s", async (user_id, role, detail) => {
    const fake = scriptedDb([
      { table: "user_profiles", data: { user_id } },
      { table: "org_members", data: { role } },
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        "person@example.com",
        "creator",
      ),
    ).toEqual({ ok: false, kind: "validation", detail });
    fake.done();
  });
  it("allows a member when the resource's creator has been deleted", async () => {
    const fake = scriptedDb([
      { table: "user_profiles", data: { user_id: "target" } },
      { table: "org_members", data: { role: "member" } },
    ]);
    expect(
      await findAssignableOrgMember(fake.db, "org", "person@example.com", null),
    ).toMatchObject({ ok: true });
    fake.done();
  });
  it("rejects a user outside the resource's organization", async () => {
    const fake = scriptedDb([
      { table: "user_profiles", data: { user_id: "target" } },
      { table: "org_members", data: null },
    ]);
    expect(
      await findAssignableOrgMember(fake.db, "org", "person@example.com", null),
    ).toMatchObject({ ok: false, kind: "validation" });
    fake.done();
  });
  it("reports a database failure distinctly from an invalid target", async () => {
    const fake = scriptedDb([
      { table: "user_profiles", error: { message: "query failed" } },
    ]);
    expect(
      await findAssignableOrgMember(fake.db, "org", "person@example.com", null),
    ).toEqual({ ok: false, kind: "db_error", error: "query failed" });
    fake.done();
  });
});
