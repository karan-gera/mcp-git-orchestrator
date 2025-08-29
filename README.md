# MCP Git Orchestrator

> Local-first Model Context Protocol (MCP) server providing AI agents with safe, structured Git control

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org)

## 🚀 Quick Start

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd mcp-git-orchestrator

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Usage with Cursor

Add the following to your Cursor settings (`.cursor-settings/settings.json`):

```json
{
  "mcp": {
    "servers": {
      "mcp-git-orchestrator": {
        "command": "npx",
        "args": ["mcp-git", "serve"],
        "env": {}
      }
    }
  }
}
```

Or generate the manifest automatically:

```bash
# Generate Cursor-compatible manifest
pnpm manifest --format cursor

# List available tools
pnpm run tools

# Test server functionality
pnpm run test
```

### Manual Server Start

```bash
# Start the MCP server (stdio mode)
pnpm serve

# Start with verbose logging
pnpm run cli serve --verbose
```

## 🛠️ Available Tools

| Tool | Description | Example Use Case |
|------|-------------|------------------|
| `repo_overview` | Repository state and branch information | Get current repo status |
| `status` | Git status with file categorization | Check working directory |
| `diff` | Flexible diff operations | View changes before commit |
| `propose_commit` | AI-powered commit message generation | Create Conventional Commits |
| `stage` | Selective file and hunk staging | Interactive staging workflow |
| `commit` | Safe commit with validation | Policy-compliant commits |
| `push` | Protected branch enforcement | Safe remote pushing |
| `branch` | Branch management with naming rules | Create feature branches |
| `merge` | Conflict analysis and forecasting | Pre-merge risk assessment |
| `conflict_map` | Conflict marker detection | Resolve merge conflicts |
| `dry_run` | Safe plan execution in isolation | Test complex workflows |

## 🔒 Safety Features

### Core Safety Mechanisms
- **No Destructive Operations**: No `reset --hard`, `push --force`, or `reflog delete`
- **Temporary Worktree Isolation**: Dry-run execution in isolated environments
- **Policy Enforcement**: Configurable rules via `.ai-vcs-policy.yaml`
- **Automatic Safety Snapshots**: Stash or worktree backups before risky operations
- **Stateless Design**: Each operation is independent and safe

### Policy Configuration

Create `.ai-vcs-policy.yaml` in your repository root:

```yaml
# AI VCS Policy Configuration
protected_branches:
  - main
  - master
  - develop

default_base: main

commit_style:
  enforce_conventional: true
  allowed_types:
    - feat
    - fix
    - docs
    - style
    - refactor
    - test
    - chore
  require_scope: false
  max_length: 72

branch_naming:
  pattern: "^(feature|bugfix|hotfix|chore)\/[a-z0-9-]+$"
  examples:
    - "feature/user-authentication"
    - "bugfix/login-validation"
    - "chore/update-dependencies"

deny_force_push: true

prepush_checks:
  - name: "npm test"
    required: true
  - name: "npm run lint"
    required: false

merge_strategy: "merge"  # merge, rebase, squash

safety_snapshots:
  auto_stash: true
  worktree_for_conflicts: true
```

## 🏗️ Architecture

```
mcp-git-orchestrator/
├── packages/
│   ├── server/           # Core MCP server
│   │   ├── src/
│   │   │   ├── tools/    # Git operation tools
│   │   │   ├── git/      # Safe Git execution layer
│   │   │   ├── policy/   # Policy loading and validation
│   │   │   └── types.ts  # TypeScript interfaces
│   │   └── __tests__/    # Comprehensive test suite
│   └── cli/              # Command-line interface
│       ├── src/
│       └── dist/
├── .ai-vcs-policy.yaml   # Sample policy configuration
└── pnpm-workspace.yaml   # Monorepo configuration
```

### Key Components

- **Git Executor**: Allowlist-based command execution with timeout protection
- **Policy System**: Flexible configuration for AI behavior constraints
- **Tool System**: Modular Git operations with consistent interfaces
- **Safety Layer**: Automatic snapshots and rollback capabilities
- **Conflict Analysis**: Advanced conflict detection and resolution guidance

## 🧪 Development

### Commands

```bash
# Development mode (watch)
pnpm dev

# Run tests
pnpm test

# Run specific tool tests
pnpm test packages/server/src/tools/__tests__/

# Build for production
pnpm build

# Clean build artifacts
pnpm clean
```

### Testing

The project includes comprehensive test suites:

- **Unit Tests**: Individual tool testing with mocked Git operations
- **Integration Tests**: End-to-end workflow validation
- **Safety Tests**: Policy enforcement and error handling
- **Conflict Tests**: Merge conflict scenarios with real fixtures

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Watch mode
pnpm test:watch
```

### Example Tool Usage

```typescript
// Using tools programmatically
import { RepoOverviewTool } from '@mcp-git-orchestrator/server';

const tool = new RepoOverviewTool();
const result = await tool.execute({}, { repositoryPath: '/path/to/repo' });

if (result.success) {
  console.log(result.summary); // Human-readable summary
  console.log(result.data);    // Structured JSON data
}
```

## 🔧 Configuration

### Environment Variables

- `MCP_GIT_VERBOSE`: Enable verbose logging (set to "1")
- `MCP_GIT_POLICY_PATH`: Custom path to policy file
- `MCP_GIT_TIMEOUT`: Default operation timeout (seconds)

### CLI Commands

```bash
# Generate MCP manifest for different clients
mcp-git manifest --format cursor    # Cursor IDE
mcp-git manifest --format json      # Raw JSON

# List available tools
mcp-git tools

# Test server connectivity
mcp-git test

# Version information
mcp-git version
```

## 🎯 Use Cases

### For AI Agents
- **Safe Git Operations**: Perform Git commands without repository corruption risk
- **Policy Compliance**: Ensure all operations follow team conventions
- **Conflict Resolution**: Get intelligent guidance for merge conflicts
- **Workflow Validation**: Test complex Git workflows before execution

### For Development Teams
- **Code Review Assistance**: AI-powered commit message generation
- **Merge Conflict Prevention**: Pre-merge analysis and risk assessment
- **Branch Management**: Enforce naming conventions and protection rules
- **Safe Automation**: Automated Git operations with comprehensive safety nets

## 📚 API Reference

Each tool returns a consistent interface:

```typescript
interface ToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  summary: string;
  metadata?: Record<string, any>;
}
```

**Common Response Format:**
- `success`: Operation success status
- `data`: Structured result data (JSON)
- `error`: Error message if failed
- `summary`: One-line human-readable summary
- `metadata`: Additional context and debugging info

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'feat: add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Development Guidelines

- Follow Conventional Commits specification
- Add tests for new functionality
- Update documentation for API changes
- Ensure all safety mechanisms are maintained

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Model Context Protocol](https://modelcontextprotocol.io/) for the foundational protocol
- [Anthropic](https://www.anthropic.com/) for MCP development and tooling
- The Git community for comprehensive version control capabilities