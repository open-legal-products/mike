import { test, expect } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

for (const width of [390, 1280]) {
  for (const darkMode of [false, true]) {
    test(`connector read-only controls at ${width}px in ${darkMode ? "dark" : "light"} mode`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const readOnly = new Map<string, boolean>();
      const definitions = [
        { name: "search", title: "Search records", description: "Search existing records.", write: false, enabled: true },
        { name: "create", title: "Create record", description: "Create a record.", write: true, enabled: true },
        { name: "delete", title: "Delete record", description: "Delete a record.", write: true, enabled: false },
      ];
      const tools = (id: string) => definitions.map(tool => ({ ...tool, enabled: tool.enabled && !(readOnly.get(id) && tool.write) }));
      const mcp = (id: string, name: string, serverUrl: string) => ({
        id, name, serverUrl, transport: "streamable_http", authType: "none", enabled: true,
        readOnly: readOnly.get(id) === true, requireWriteApproval: false, hasAuthConfig: false,
        customHeaderKeys: [], oauthConnected: false, toolPolicy: {}, toolCount: definitions.length,
        createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
        tools: tools(id).map(tool => ({ ...tool, id: tool.name, toolName: tool.name, openaiToolName: tool.name, readOnly: !tool.write, destructive: tool.write, lastSeenAt: "2026-10-02T00:00:00Z" })),
      });
      const connectors = () => [mcp("slack", "Slack", "https://mcp.slack.com/mcp"), mcp("custom", "Custom MCP", "https://custom.example.com/mcp")];
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/session") return route.fulfill({ json: { user: { id: "mode-test", email: "mode@example.com" } } });
        if (path === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Mode test", darkMode, apiKeyStatus: {}, creditsRemaining: 100 } });
        if (path === "/api/user/mcp-connectors") return route.fulfill({ json: connectors() });
        if (path.includes("/user/mcp-connectors/") || path.includes("/user/integrations/")) {
          const id = path.split("/").at(-1)!;
          if (route.request().method() === "PATCH") readOnly.set(id, route.request().postDataJSON().readOnly);
          if (path.includes("mcp-connectors")) return route.fulfill({ json: connectors().find(connector => connector.id === id) });
          return route.fulfill({ json: { configured: true, schemaReady: true, connected: true, enabled: true, writeEnabled: true, readOnly: readOnly.get(id) === true, requireWriteApproval: false, accountEmail: "mode@example.com", tools: tools(id) } });
        }
        return route.fulfill({ json: [] });
      });
      await page.goto("/settings/connectors");
      for (const [name, id] of [["Google Drive", "google-drive"], ["Gmail", "gmail"], ["Google Calendar", "google-calendar"], ["Slack", "slack"], ["Custom MCP", "custom"]]) {
        const open = async () => {
          await page.getByRole("button", { name: `Manage ${name}`, exact: true }).click();
          const dialog = page.getByRole("dialog", { name, exact: true });
          if (id === "custom") await dialog.getByRole("button", { name: "Tools", exact: true }).click();
          return dialog;
        };
        let dialog = await open();
        await expect(dialog.getByRole("switch", { name: "Ask for permission for write actions" })).toBeVisible();
        await dialog.getByRole("switch", { name: "Read-only", exact: true }).click();
        await expect(dialog.getByRole("switch", { name: "Read-only", exact: true })).toBeChecked();
        await expect(dialog.getByText("Ask for permission for write actions", { exact: true })).toHaveCount(0);
        const write = dialog.getByRole("switch", { name: "Create record enabled" });
        await expect(write).not.toBeChecked();
        await expect(write).toBeDisabled();
        await expect(dialog.getByRole("switch", { name: "Delete record enabled" })).toBeDisabled();
        await expect(dialog.getByRole("switch", { name: "Search records enabled" })).toBeEnabled();
        await expect(dialog.getByRole("switch", { name: "Search records enabled" })).toBeChecked();
        const geometry = await dialog.evaluate(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, overflow: el.scrollWidth - el.clientWidth }));
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`${id}-read-only.png`), animations: "disabled" });
        await page.reload();
        dialog = await open();
        await expect(dialog.getByRole("switch", { name: "Read-only", exact: true })).toBeChecked();
        await expect(dialog.getByText("Ask for permission for write actions", { exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("switch", { name: "Create record enabled" })).toBeDisabled();
        await dialog.getByRole("switch", { name: "Read-only", exact: true }).click();
        await expect(dialog.getByRole("switch", { name: "Create record enabled" })).toBeChecked();
        await expect(dialog.getByRole("switch", { name: "Create record enabled" })).toBeEnabled();
        await expect(dialog.getByRole("switch", { name: "Ask for permission for write actions" })).toBeVisible();
        await expect(dialog.getByRole("switch", { name: "Delete record enabled" })).not.toBeChecked();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
      }
    });
  }
}
