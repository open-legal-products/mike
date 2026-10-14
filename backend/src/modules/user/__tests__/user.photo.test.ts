import { describe, it, expect, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import { setUserProfilePhoto } from "../user.photo";
import { MAX_PROFILE_IMAGE_BYTES } from "../../../lib/profileImage";

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=";
function database(error: unknown = null) {
  const query = {
    upsert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ error }),
  };
  const from = vi.fn(() => query);
  return { db: { from } as unknown as Db, query, from };
}

describe("profile photo persistence", () => {
  it("stores only the authenticated account's bounded raster photo", async () => {
    const { db, query } = database();
    expect(await setUserProfilePhoto(db, "caller", PHOTO)).toEqual({ ok: true, data: { profilePhoto: PHOTO } });
    expect(query.update).toHaveBeenCalledWith({ profile_photo: PHOTO, updated_at: expect.any(String) });
    expect(query.eq).toHaveBeenCalledWith("user_id", "caller");
  });
  it("removes the photo without touching other profile fields", async () => {
    const { db, query } = database();
    expect(await setUserProfilePhoto(db, "caller", null)).toEqual({ ok: true, data: { profilePhoto: null } });
    expect(query.update).toHaveBeenCalledWith({ profile_photo: null, updated_at: expect.any(String) });
    expect(query.eq).toHaveBeenCalledWith("user_id", "caller");
  });
  it.each([undefined, "", 3, "https://example.com/photo.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,PHN2Zy8+"])("rejects invalid data before database access: %s", async (value) => {
    const { db, from } = database();
    expect(await setUserProfilePhoto(db, "caller", value)).toMatchObject({ ok: false, kind: "validation" });
    expect(from).not.toHaveBeenCalled();
  });
  it("rejects an oversized image", async () => {
    const { db, from } = database();
    const bytes = Buffer.alloc(MAX_PROFILE_IMAGE_BYTES + 1);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
    expect(await setUserProfilePhoto(db, "caller", `data:image/png;base64,${bytes.toString("base64")}`)).toMatchObject({ ok: false, kind: "validation" });
    expect(from).not.toHaveBeenCalled();
  });
  it("returns a safe service failure on database errors", async () => {
    const error = new Error("private database detail");
    const { db } = database(error);
    expect(await setUserProfilePhoto(db, "caller", PHOTO)).toEqual({ ok: false, kind: "error", error });
  });
});
