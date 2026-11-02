import { describe, expect, it, vi } from "vitest";
import {
  changePrivateContentAccess,
  listPrivateContent,
  setPrivateContentPermission,
} from "../orgs.privateContent";
const target = "00000000-0000-4000-8000-000000000001";
const actor = { orgId: "org", userId: "authenticated-user" };

describe("organization private content service", () => {
  it("opens and closes only through the audited transaction with the authenticated actor", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    for (const open of [true, false]) {
      expect(
        await changePrivateContentAccess({ rpc } as never, {
          ...actor,
          kind: "document",
          itemId: target,
          open,
        }),
      ).toEqual({ ok: true, data: null });
      expect(rpc).toHaveBeenLastCalledWith(
        open ? "open_org_private_content" : "close_org_private_content",
        {
          p_org_id: "org",
          p_actor_id: "authenticated-user",
          p_kind: "document",
          p_item_id: target,
        },
      );
    }
  });
  it("rejects malformed permission and resource requests before accessing the database", async () => {
    const rpc = vi.fn();
    for (const input of [
      { targetUserId: target, enabled: "true" },
      { targetUserId: "not-uuid", enabled: true },
    ])
      expect(
        await setPrivateContentPermission({ rpc } as never, {
          ...actor,
          ...input,
        }),
      ).toMatchObject({ ok: false, kind: "validation" });
    for (const input of [
      { kind: "personal", itemId: target },
      { kind: "document", itemId: "bad" },
    ])
      expect(
        await changePrivateContentAccess({ rpc } as never, {
          ...actor,
          ...input,
          open: true,
        }),
      ).toMatchObject({ ok: false, kind: "validation" });
    expect(
      await listPrivateContent({ rpc } as never, {
        ...actor,
        limit: 50,
        offset: 0,
        search: [],
      }),
    ).toMatchObject({ ok: false, kind: "validation" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("changes an admin permission through the owner-authorized audited transaction", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    expect(
      await setPrivateContentPermission({ rpc } as never, {
        ...actor,
        targetUserId: target,
        enabled: false,
      }),
    ).toEqual({ ok: true, data: null });
    expect(rpc).toHaveBeenCalledWith("set_org_private_content_permission", {
      p_org_id: "org",
      p_actor_id: "authenticated-user",
      p_target_id: target,
      p_enabled: false,
    });
  });
  it.each([
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["23514", "validation"],
    ["22P02", "validation"],
    ["XX000", "error"],
  ])(
    "maps refusal %s to %s without exposing the database error",
    async (code, kind) => {
      const rpc = vi
        .fn()
        .mockResolvedValue({
          error: { code, message: "private database detail" },
        });
      const result = await changePrivateContentAccess({ rpc } as never, {
        ...actor,
        kind: "project",
        itemId: target,
        open: true,
      });
      expect(result).toMatchObject({ ok: false, kind });
      if (!result.ok && result.kind !== "error")
        expect(result.detail).not.toContain("database detail");
    },
  );
  it("uses a lookahead row for pagination without returning it", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({
        data: [{ item_id: "one" }, { item_id: "two" }, { item_id: "next" }],
      });
    expect(
      await listPrivateContent({ rpc } as never, {
        ...actor,
        limit: 2,
        offset: 4,
        search: "  %NDA  ",
      }),
    ).toEqual({
      ok: true,
      data: { items: [{ item_id: "one" }, { item_id: "two" }], nextOffset: 6 },
    });
    expect(rpc).toHaveBeenCalledWith("list_org_private_content", {
      p_org_id: "org",
      p_actor_id: "authenticated-user",
      p_limit: 3,
      p_offset: 4,
      p_search: "%NDA",
    });
  });
});
