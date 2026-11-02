import { describe, expect, it, vi } from "vitest";
import {
  hasOrgPrivateContentAccess,
  listOrgPrivateContentAccess,
} from "../orgPrivateContent";

describe("private organization content access", () => {
  it("never queries a personal or unidentified item", async () => {
    const rpc = vi.fn();
    expect(
      await hasOrgPrivateContentAccess(
        { rpc } as never,
        null,
        "user",
        "document",
        "doc",
      ),
    ).toBe(false);
    expect(
      await hasOrgPrivateContentAccess(
        { rpc } as never,
        "org",
        "user",
        "document",
        undefined,
      ),
    ).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["project", "workflow", "chat", "tabular_review"] as const)(
    "accepts only an explicit viewer verdict for %s",
    async (kind) => {
      const rpc = vi
        .fn()
        .mockResolvedValueOnce({ data: "viewer" })
        .mockResolvedValueOnce({ data: null })
        .mockResolvedValueOnce({ data: "owner" })
        .mockResolvedValueOnce({
          data: "viewer",
          error: { message: "failure" },
        });
      const check = () =>
        hasOrgPrivateContentAccess(
          { rpc } as never,
          "org",
          "actor",
          kind,
          "item",
        );
      expect(await check()).toBe(true);
      expect(await check()).toBe(false);
      expect(await check()).toBe(false);
      expect(await check()).toBe(false);
      expect(rpc).toHaveBeenCalledWith("org_private_access_role", {
        p_org_id: "org",
        p_user_id: "actor",
        p_kind: kind,
        p_item_id: "item",
      });
    },
  );
  it("checks current document scope and revocation on every read", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: false });
    expect(
      await hasOrgPrivateContentAccess(
        { rpc } as never,
        "org",
        "actor",
        "document",
        "doc",
      ),
    ).toBe(true);
    expect(
      await hasOrgPrivateContentAccess(
        { rpc } as never,
        "org",
        "actor",
        "document",
        "doc",
      ),
    ).toBe(false);
    expect(rpc).toHaveBeenCalledWith("org_private_document_access", {
      p_org_id: "org",
      p_document_id: "doc",
      p_user_id: "actor",
    });
  });
  it("pages directory access beyond a REST response cap and fails closed on errors", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: 500 }, (_, i) => ({
          kind: "project",
          item_id: String(i),
        })),
      })
      .mockResolvedValueOnce({ data: [{ kind: "workflow", item_id: "last" }] });
    const result = await listOrgPrivateContentAccess(
      { rpc } as never,
      ["org"],
      "actor",
    );
    expect(result.get("project")?.size).toBe(500);
    expect(result.get("workflow")?.has("last")).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("list_org_private_content_access", {
      p_org_ids: ["org"],
      p_user_id: "actor",
      p_offset: 500,
    });
    rpc.mockResolvedValueOnce({
      error: { message: "private database detail" },
    });
    await expect(
      listOrgPrivateContentAccess({ rpc } as never, ["org"], "actor"),
    ).rejects.toThrow("Could not read private content access");
  });
});
