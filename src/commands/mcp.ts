/**
 * `nat mcp` — run the MCP server, or print the config to register it.
 */

import { Command } from "commander";
import { emit } from "../core/output.js";
import { NatError } from "../core/errors.js";
import { startMcpServer } from "../mcp/server.js";
import { version } from "../core/version.js";

const CLIENTS: Record<string, { file: string; shape: (entry: object) => object }> = {
  claude: {
    file: "~/.claude.json  (or run: claude mcp add native-ai-tester -- nat mcp serve)",
    shape: (entry) => ({ mcpServers: { "native-ai-tester": entry } }),
  },
  cursor: {
    file: "~/.cursor/mcp.json  (or .cursor/mcp.json in the project)",
    shape: (entry) => ({ mcpServers: { "native-ai-tester": entry } }),
  },
  vscode: {
    file: ".vscode/mcp.json",
    shape: (entry) => ({ servers: { "native-ai-tester": { ...entry, type: "stdio" } } }),
  },
  codex: {
    file: "~/.codex/config.toml",
    shape: (entry) => ({ mcp_servers: { native_ai_tester: entry } }),
  },
};

export function registerMcpCommands(program: Command): void {
  const mcp = program.command("mcp").description("expose the device loop to MCP-speaking agents");

  mcp
    .command("serve", { isDefault: true })
    .description("run the MCP server on stdio (this is what an MCP client launches)")
    .action(async () => {
      await startMcpServer(version());
      // The server owns the process from here — it exits when stdio closes.
      await new Promise(() => {});
    });

  mcp
    .command("config")
    .description("print the configuration snippet for an MCP client")
    .option("--client <name>", `one of: ${Object.keys(CLIENTS).join(", ")}`, "claude")
    .action((options: { client: string }) => {
      const client = CLIENTS[options.client.toLowerCase()];
      if (!client) {
        throw new NatError("INVALID_ARGUMENT", `Unknown MCP client \`${options.client}\``, {
          hint: `Known clients: ${Object.keys(CLIENTS).join(", ")}`,
        });
      }

      const entry = { command: "nat", args: ["mcp", "serve"] };
      const config = client.shape(entry);

      emit(config, () =>
        [
          `Add this to ${client.file}:`,
          "",
          JSON.stringify(config, null, 2),
          "",
          "The server drives whichever device `nat devices connect` is pointed at,",
          "so the CLI and MCP tools share one session.",
        ].join("\n"),
      );
    });
}
