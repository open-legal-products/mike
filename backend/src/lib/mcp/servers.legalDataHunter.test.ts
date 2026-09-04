import { describe, expect, it, vi } from "vitest";
import {
  createUserMcpConnector,
  deleteUserMcpConnector,
  ensureUserLegalDataHunterConnector,
  updateUserMcpConnector,
} from "./servers";
import type { ConnectorRow, Db } from "./types";

const connectorRow: ConnectorRow = {
  id: "connector-1",
  user_id: "user-1",
  name: "Legal Data Hunter",
  transport: "streamable_http",
  server_url: "https://legaldatahunter.com/mcp",
  auth_type: "none",
  enabled: false,
  tool_policy: {},
  encrypted_auth_config: null,
  auth_config_iv: null,
  auth_config_tag: null,
  created_at: "2026-09-02T00:00:00.000Z",
  updated_at: "2026-09-02T00:00:00.000Z",
};

function dbWithRpc() {
  return {
    rpc: vi.fn().mockResolvedValue({ data: [connectorRow], error: null }),
  } as unknown as Db;
}

describe("built-in Legal Data Hunter connector", () => {
  it("ensures the canonical connector through the serialized database RPC", async () => {
    const db = dbWithRpc();

    await expect(
      ensureUserLegalDataHunterConnector("user-1", db),
    ).resolves.toMatchObject({
      id: "connector-1",
      name: "Legal Data Hunter",
      serverUrl: "https://legaldatahunter.com/mcp",
      enabled: false,
    });
    expect(db.rpc).toHaveBeenCalledWith("ensure_legal_data_hunter_connector", {
      p_user_id: "user-1",
    });
  });

  it("reserves the canonical endpoint from generic connector creation", async () => {
    const db = { from: vi.fn() } as unknown as Db;

    await expect(
      createUserMcpConnector(
        "user-1",
        {
          name: "Custom",
          serverUrl: "https://legaldatahunter.com/mcp",
        },
        db,
      ),
    ).rejects.toThrow("Settings → Features");
    expect(db.from).not.toHaveBeenCalled();
  });

  it.each([
    "HTTPS://LEGALDATAHUNTER.COM/mcp",
    "https://legaldatahunter.com:443/mcp",
    "https://legaldatahunter.com:0443/mcp",
    "https://legaldatahunter.com/mcp/",
    "https://legaldatahunter.com/mcp?client=custom",
    "https://legaldatahunter.com/%6dcp",
    "https://legaldatahunter.com/m%63p",
    "https://legaldatahunter.com/%6d%63%70",
    "https://legaldatahunter.com///mcp//",
    "https://legaldatahunter.com./mcp",
  ])("reserves equivalent managed endpoint spelling %s", async (serverUrl) => {
    const db = { from: vi.fn() } as unknown as Db;

    await expect(
      createUserMcpConnector("user-1", { name: "Custom", serverUrl }, db),
    ).rejects.toThrow("Settings → Features");
    expect(db.from).not.toHaveBeenCalled();
  });

  it("reserves the canonical endpoint from generic connector updates", async () => {
    const db = { from: vi.fn() } as unknown as Db;

    await expect(
      updateUserMcpConnector(
        "user-1",
        "connector-1",
        { serverUrl: "https://legaldatahunter.com/mcp" },
        db,
      ),
    ).rejects.toThrow("Settings → Features");
    expect(db.from).not.toHaveBeenCalled();
  });

  it("blocks generic mutation of the managed connector", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn().mockResolvedValue({ data: connectorRow, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const db = { from: vi.fn().mockReturnValue(query) } as unknown as Db;

    await expect(
      updateUserMcpConnector(
        "user-1",
        "connector-1",
        { name: "Renamed managed connector" },
        db,
      ),
    ).rejects.toThrow("Settings → Features");
  });

  it("blocks generic deletion of the managed connector", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn().mockResolvedValue({ data: connectorRow, error: null }),
      delete: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.delete.mockReturnValue(query);
    const db = { from: vi.fn().mockReturnValue(query) } as unknown as Db;

    await expect(
      deleteUserMcpConnector("user-1", "connector-1", db),
    ).rejects.toThrow("Settings → Features");
  });
});
