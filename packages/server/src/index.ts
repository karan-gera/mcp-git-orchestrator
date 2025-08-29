/**
 * MCP Git Orchestrator Server
 * 
 * Provides safe, structured control over Git operations for AI agents.
 * Implements stateless design with comprehensive safety mechanisms.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import all our tools
import {
  RepoOverviewTool,
  StatusTool,
  DiffTool,
  ProposeCommitTool,
  StageTool,
  CommitTool,
  PushTool,
  BranchTool,
  MergeTool,
  ConflictMapTool,
  DryRunTool
} from './tools/index.js';

const server: Server = new Server(
  {
    name: 'mcp-git-orchestrator',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize all tools
const tools = {
  repo_overview: new RepoOverviewTool(),
  status: new StatusTool(),
  diff: new DiffTool(),
  propose_commit: new ProposeCommitTool(),
  stage: new StageTool(),
  commit: new CommitTool(),
  push: new PushTool(),
  branch: new BranchTool(),
  merge: new MergeTool(),
  conflict_map: new ConflictMapTool(),
  dry_run: new DryRunTool()
};

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.getDescription(),
      inputSchema: tool.getInputSchema(),
    })),
  };
});

// Register tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Get the tool
  const tool = tools[name as keyof typeof tools];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    // Execute the tool with proper type casting
    const result = await tool.execute(args as any || {});

    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: `✅ ${result.summary}\n\n${JSON.stringify(result.data, null, 2)}`
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error: ${result.error}\n\nDetails: ${JSON.stringify(result.metadata || {}, null, 2)}`
          }
        ],
        isError: true
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: `💥 Tool execution failed: ${errorMessage}`
        }
      ],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Git Orchestrator server running on stdio');
  console.error(`Tools available: ${Object.keys(tools).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}

export { server };
export type { Server };