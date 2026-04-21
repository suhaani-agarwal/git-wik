import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { researchIssueTool, handleResearchIssue } from "./tools/research-issue.js";
import { getFileLoreTool, handleGetFileLore } from "./tools/get-file-lore.js";
import { findImplementationContextTool, handleFindImplementationContext } from "./tools/find-implementation-context.js";
import { findSimilarTool, handleFindSimilar } from "./tools/find-similar.js";
import { getPRContextTool, handleGetPRContext } from "./tools/get-pr-context.js";
import { getContextTool, handleGetContext } from "./tools/get-context.js";
import { explainLineTool, handleExplainLine } from "./tools/explain-line.js";

// ── Tool registry ─────────────────────────────────────────────────────────────

const TOOLS = [
  getContextTool,
  explainLineTool,
  researchIssueTool,
  getFileLoreTool,
  findImplementationContextTool,
  findSimilarTool,
  getPRContextTool,
] as const;

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "git-wik", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const safeArgs = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "get_context":
      return handleGetContext(safeArgs);
    case "explain_line":
      return handleExplainLine(safeArgs);
    case "research_issue":
      return handleResearchIssue(safeArgs);
    case "get_file_lore":
      return handleGetFileLore(safeArgs);
    case "find_implementation_context":
      return handleFindImplementationContext(safeArgs);
    case "find_similar":
      return handleFindSimilar(safeArgs);
    case "get_pr_context":
      return handleGetPRContext(safeArgs);
    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
