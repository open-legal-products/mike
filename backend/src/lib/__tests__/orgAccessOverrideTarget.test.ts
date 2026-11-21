import { describe, expect, it } from "vitest";
import { findAssignableOrgMember } from "../orgAccessOverrides";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";

/** The two reads a lookup makes: the profile by email, then the membership. */
function memberLookup(user_id: string, role: string, email: string) {
  return [
    { table: "user_profiles", data: [{ user_id, email }] },
    { table: "org_members", data: [{ user_id, role }] },
  ];
}

describe("organization override target shared by projects and workflows", () => {
  it("normalizes the email and scopes membership to the resource's organization", async () => {
    const fake = scriptedDb([
      ...memberLookup("target", "member", "person@example.com"),
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        " Person@Example.com ",
        "creator",
        "private",
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
      ["in", "email", ["person@example.com"]],
    ]);
    expect(fake.calls[1].filters).toEqual([
      ["eq", "org_id", "org"],
      ["in", "user_id", ["target"]],
    ]);
    fake.done();
  });
  it.each([
    ["creator", "member", "private", "The creator is always an owner"],
    ["creator", "admin", "private", "The creator is always an owner"],
    ["creator", "owner", "private", "The creator is always an owner"],
    ["creator", "member", "organization", "The creator is always an owner"],
    [
      "someone",
      "owner",
      "organization",
      "Organization owners always own a public item",
    ],
  ])(
    "protects %s with org role %s on a %s item",
    async (user_id, role, visibility, detail) => {
      const fake = scriptedDb([
        ...memberLookup(user_id, role, "person@example.com"),
      ]);
      expect(
        await findAssignableOrgMember(
          fake.db,
          "org",
          "person@example.com",
          "creator",
          visibility,
        ),
      ).toEqual({ ok: false, kind: "validation", detail });
      fake.done();
    },
  );
  it("lets an organization owner be shared a private item, like any other member", async () => {
    // Owning the organization gives no standing on a member's private
    // matter, so there is something to give them, and nothing to protect.
    const fake = scriptedDb([
      ...memberLookup("principal", "owner", "principal@example.com"),
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        "principal@example.com",
        "creator",
        "private",
      ),
    ).toEqual({
      ok: true,
      member: {
        userId: "principal",
        email: "principal@example.com",
        orgRole: "owner",
      },
    });
    fake.done();
  });
  it("lets an admin be shared with, or walled off, like any other member", async () => {
    // Administering the organization gives no standing on its content, so
    // there is nothing implicit here to protect.
    const fake = scriptedDb([
      ...memberLookup("manager", "admin", "manager@example.com"),
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        "manager@example.com",
        "creator",
        "organization",
      ),
    ).toEqual({
      ok: true,
      member: { userId: "manager", email: "manager@example.com", orgRole: "admin" },
    });
    fake.done();
  });
  it("allows a member when the resource's creator has been deleted", async () => {
    const fake = scriptedDb([
      ...memberLookup("target", "member", "person@example.com"),
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        "person@example.com",
        null,
        "private",
      ),
    ).toMatchObject({ ok: true });
    fake.done();
  });
  it("rejects a user outside the resource's organization", async () => {
    const fake = scriptedDb([
      { table: "user_profiles", data: [{ user_id: "target", email: "person@example.com" }] },
      { table: "org_members", data: [] },
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        "person@example.com",
        null,
        "private",
      ),
    ).toMatchObject({ ok: false, kind: "validation" });
    fake.done();
  });
  it("reports a database failure distinctly from an invalid target", async () => {
    const fake = scriptedDb([
      { table: "user_profiles", error: { message: "query failed" } },
    ]);
    expect(
      await findAssignableOrgMember(
        fake.db,
        "org",
        "person@example.com",
        null,
        "private",
      ),
    ).toEqual({ ok: false, kind: "db_error", error: "member profiles by email failed" });
    fake.done();
  });
});
