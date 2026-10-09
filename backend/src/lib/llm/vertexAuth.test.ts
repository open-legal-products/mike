import { afterEach, describe, expect, it } from "vitest";
import { resetVertexAuthClients, vertexAuthClient } from "./vertexAuth";

const account = {
  clientEmail: "mike@legal-prod.iam.gserviceaccount.com",
  privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  privateKeyId: "key-1",
  project: "legal-prod",
};

describe("vertexAuthClient", () => {
  afterEach(() => resetVertexAuthClients());

  it("reuses one client per key so its access token is cached", async () => {
    const first = await vertexAuthClient(account);
    expect(await vertexAuthClient({ ...account })).toBe(first);
    expect(first.email).toBe(account.clientEmail);
    expect(first.keyId).toBe("key-1");
    expect(first.scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
  });

  it("gives a replaced key its own client", async () => {
    const first = await vertexAuthClient(account);
    const rotated = await vertexAuthClient({
      ...account,
      privateKey: account.privateKey.replace("abc", "xyz"),
    });
    expect(rotated).not.toBe(first);
  });

  it("bounds the cache", async () => {
    const first = await vertexAuthClient(account);
    for (let index = 0; index < 200; index++) {
      await vertexAuthClient({ ...account, privateKey: `key-${index}` });
    }
    expect(await vertexAuthClient(account)).not.toBe(first);
  });
});
