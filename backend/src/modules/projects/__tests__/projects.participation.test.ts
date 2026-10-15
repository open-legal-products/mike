import { expect, it } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { filterParticipatingProjects } from "../projects.participation";

it("keeps creators and explicit project members, excluding inherited owner/admin and audited access", async () => {
  const projects = [
    { id: "created", user_id: "actor", org_id: "org", access_role: "owner" },
    { id: "direct-owner", user_id: "other", org_id: "org", access_role: "owner" },
    { id: "direct-editor", user_id: "other", org_id: "org", access_role: "editor" },
    { id: "direct-viewer", user_id: "other", org_id: "org", access_role: "viewer" },
    { id: "inherited-owner", user_id: "other", org_id: "org", access_role: "owner" },
    { id: "public-member", user_id: "other", org_id: "org", access_role: "editor" },
    { id: "audited", user_id: "other", org_id: "org", access_role: "viewer" },
    { id: "ownerless", user_id: null, org_id: "org", access_role: "owner" },
    { id: "personal-share", user_id: "other", org_id: null, access_role: "viewer" },
  ];
  const fake = scriptedDb([
    { table: "project_access_grants", data: [{ project_id: "personal-share" }] },
    { table: "project_org_access_overrides", data: ["direct-owner", "direct-editor", "direct-viewer", "no-longer-accessible"].map(project_id => ({ project_id })) },
  ]);
  const result = await filterParticipatingProjects(fake.db, projects, "actor", " ACTOR@example.test ");
  expect(result).toEqual({ ok: true, data: projects.filter(p => ["created", "direct-owner", "direct-editor", "direct-viewer", "personal-share"].includes(p.id)) });
  expect(fake.calls[0].filters).toContainEqual(["eq", "email", "actor@example.test"]);
  expect(fake.calls[1].filters).toContainEqual(["eq", "user_id", "actor"]);
  expect(fake.calls[1].filters).toContainEqual(["in", "role", ["owner", "editor", "viewer"]]);
  fake.done();
});

it("does not fall back to inherited permissions when the direct-membership read fails", async () => {
  const error = { code: "42P01", message: "private details" };
  const fake = scriptedDb([{ table: "project_org_access_overrides", error }]);
  expect(await filterParticipatingProjects(fake.db, [
    { id: "created", user_id: "actor", org_id: "org" },
    { id: "inherited", user_id: "other", org_id: "org" },
  ], "actor")).toMatchObject({ ok: false, kind: "error", error });
  fake.done();
});

it("bounds membership query URLs without dropping later projects", async () => {
  const projects = Array.from({ length: 205 }, (_, i) => ({ id: `p${i}`, org_id: "org", user_id: "other" }));
  const fake = scriptedDb([0, 100, 200].map(offset => ({
    table: "project_org_access_overrides", data: projects.slice(offset, offset + 100).map(p => ({ project_id: p.id })),
  })));
  expect(await filterParticipatingProjects(fake.db, projects, "actor")).toEqual({ ok: true, data: projects });
  expect(fake.calls.map(call => (call.filters.find(f => f[0] === "in" && f[1] === "project_id")![2] as string[]).length)).toEqual([100, 100, 5]);
  fake.done();
});

it("keeps owned projects without querying and does not guess email-based membership", async () => {
  const fake = scriptedDb([]);
  const owned = { id: "owned", user_id: "actor", org_id: null };
  expect(await filterParticipatingProjects(fake.db, [owned, { id: "other", user_id: "other", org_id: null }], "actor")).toEqual({ ok: true, data: [owned] });
  fake.done();
});
