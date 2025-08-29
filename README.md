# MCP Git Orchestrator

> Local-first Model Context Protocol (MCP) server providing AI agents with safe, structured Git control

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](https://www.typescriptlang.org)

## Quick Start

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
        "env": {
          "GITHUB_TOKEN": "your_token_here"
        }
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

# Start with GitHub integration
GITHUB_TOKEN=your_token_here pnpm serve
```

## AI Agent Workflow Guide

### Plan → Review → Execute Pattern

The MCP Git Orchestrator is designed for AI agents to follow a safe three-phase workflow:

#### **Phase 1: Plan**
Use analysis tools to understand the current state and plan operations:

```bash
# 1. Get repository overview
repo_overview()
# Returns: branch, head, remotes, ahead/behind status

# 2. Check current status
status()
# Returns: staged, unstaged, untracked files

# 3. Analyze changes
diff({ scope: "unstaged" })
# Returns: detailed diff with hunks and file changes

# 4. Plan commit message
propose_commit({ include_analysis: true })
# Returns: intelligent commit message with scope detection
```

#### **Phase 2: Review**
Test operations safely before execution:

```bash
# Create a comprehensive plan
dry_run({
  plan: [
    { operation: "stage", args: { paths: ["src/"] } },
    { operation: "commit", args: { message: "feat: add new feature" } },
    { operation: "push", args: { remote: "origin" } }
  ],
  fail_fast: false
})
# Returns: execution transcript, risk analysis, rollback instructions
```

#### **Phase 3: Execute**
Execute operations with confidence:

```bash
# Stage files
stage({ paths: ["src/feature.ts", "tests/feature.test.ts"] })

# Commit with validation
commit({ message: "feat: add user authentication system" })

# Push with safety checks
push({ remote: "origin", branch: "feature/auth" })

# Create pull request (if GitHub integration enabled)
pr_create({
  title: "feat: user authentication system",
  body: "Implements JWT-based authentication with role management",
  labels: ["feature", "security"]
})
```

### Safety-First Principles

1. **Always analyze before acting**: Use `repo_overview` and `status` first
2. **Test with dry-run**: Validate complex workflows before execution
3. **Respect policies**: The system automatically enforces repository policies
4. **Handle conflicts intelligently**: Use `conflict_map` for merge conflicts
5. **Maintain clean history**: Follow conventional commits and branch naming

## Available Tools

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
| `pr_create` | GitHub pull request creation (optional) | Create PRs with diffstat |

## Policy Configuration

### Complete `.ai-vcs-policy.yaml` Schema

Create a comprehensive policy file in your repository root:

```yaml
# AI VCS Policy Configuration
# Complete configuration file for MCP Git Orchestrator

# Branch Protection
protected_branches:
  - main
  - master
  - develop
  - release/*
  - hotfix/*

# Default base branch for new features and PRs
default_base: main

# Commit Message Conventions
commit_style:
  # Enforce Conventional Commits specification
  enforce_conventional: true
  
  # Allowed commit types
  allowed_types:
    - feat        # New features
    - fix         # Bug fixes
    - docs        # Documentation changes
    - style       # Code style changes (formatting, etc.)
    - refactor    # Code refactoring
    - perf        # Performance improvements
    - test        # Adding or updating tests
    - chore       # Maintenance tasks
    - ci          # CI/CD changes
    - build       # Build system changes
    - revert      # Reverting previous commits
  
  # Require scope in commit messages (e.g., feat(auth): add login)
  require_scope: false
  
  # Maximum commit message length
  max_length: 72
  
  # Require body for certain types
  require_body_for:
    - feat
    - fix

# Branch Naming Conventions
branch_naming:
  # Allowed branch name pattern (regex)
  pattern: "^(feature|feat|bugfix|fix|hotfix|chore|docs|refactor|perf|test|ci)\/[a-z0-9-]+$"
  
  # Maximum branch name length
  max_length: 50
  
  # Examples for documentation
  examples:
    - "feature/user-authentication"
    - "fix/login-validation-error"
    - "hotfix/critical-security-patch"
    - "chore/update-dependencies"

# Force Push Protection
deny_force_push: true

# Pre-push Validation Checks
prepush_checks:
  # Run tests before pushing
  - name: "npm test"
    required: true
    timeout: 300  # 5 minutes
    
  # Run linting
  - name: "npm run lint"
    required: false
    timeout: 60   # 1 minute

# Merge Strategy Configuration
merge_strategy: "merge"  # Options: merge, rebase, squash

# Safety Snapshots Configuration
safety_snapshots:
  # Automatically create stash before risky operations
  auto_stash: true
  
  # Use worktree isolation for conflict resolution
  worktree_for_conflicts: true
  
  # Keep snapshots for X days
  retention_days: 7

# GitHub Integration (when GITHUB_TOKEN is available)
github:
  # Auto-assign reviewers based on files changed
  auto_reviewers:
    "src/auth/*": ["@security-team"]
    "src/api/*": ["@backend-team"]
    "src/ui/*": ["@frontend-team"]
  
  # Auto-assign labels based on branch or files
  auto_labels:
    "feature/*": ["enhancement"]
    "fix/*": ["bug"]
    "hotfix/*": ["hotfix", "priority-high"]
```

### Policy Examples by Project Type

#### **Frontend React/Vue Project**
```yaml
commit_style:
  enforce_conventional: true
  allowed_types: [feat, fix, style, refactor, test, chore]
  require_scope: true

branch_naming:
  pattern: "^(feature|fix|hotfix|chore)\/[a-z0-9-]+$"

prepush_checks:
  - name: "npm run build"
    required: true
  - name: "npm run test"
    required: true
  - name: "npm run lint"
    required: false

file_rules:
  require_review:
    - "package.json"
    - "webpack.config.js"
    - "vite.config.ts"
```

#### **Backend API Project**
```yaml
commit_style:
  enforce_conventional: true
  allowed_types: [feat, fix, perf, refactor, test, chore, security]
  require_body_for: [feat, fix, security]

prepush_checks:
  - name: "npm run test"
    required: true
  - name: "npm run lint"
    required: true
  - name: "npm run security-audit"
    required: true

file_rules:
  require_review:
    - "package.json"
    - "docker-compose.yml"
    - "Dockerfile"
    - "src/config/*"
  
  forbidden_files:
    - "*.env"
    - "*.key"
    - "secrets.json"
```

#### **Library/Package Project**
```yaml
commit_style:
  enforce_conventional: true
  allowed_types: [feat, fix, docs, style, refactor, test, chore, build]
  require_scope: false
  max_length: 100

prepush_checks:
  - name: "npm run build"
    required: true
  - name: "npm run test"
    required: true
  - name: "npm run docs:build"
    required: false

merge_strategy: "squash"  # Clean history for releases

quality_rules:
  require_tests_for_features: true
  max_lines_per_commit: 300
```

## Safety Features

### Core Safety Mechanisms
- **No Destructive Operations**: No `reset --hard`, `push --force`, or `reflog delete`
- **Temporary Worktree Isolation**: Dry-run execution in isolated environments
- **Policy Enforcement**: Configurable rules via `.ai-vcs-policy.yaml`
- **Automatic Safety Snapshots**: Stash or worktree backups before risky operations
- **Stateless Design**: Each operation is independent and safe

### Safety Snapshots and Recovery

#### **Automatic Safety Snapshots**
The system automatically creates safety snapshots before risky operations:

```bash
# Before merge conflicts, a worktree snapshot is created
merge({ target: "main" })
# Creates: .git/worktrees/mcp-safety-TIMESTAMP

# Before destructive operations, a stash is created
commit({ message: "feat: major changes", amend: true })
# Creates: stash@{0}: MCP safety snapshot - TIMESTAMP
```

#### **Manual Recovery Commands**
If you need to restore from a safety snapshot:

```bash
# List available safety snapshots
git stash list | grep "MCP safety"

# Restore from latest safety stash
git stash pop stash@{0}

# Or restore from specific stash
git stash apply stash@{1}

# List safety worktrees
git worktree list | grep mcp-safety

# Remove old safety worktrees
git worktree remove .git/worktrees/mcp-safety-TIMESTAMP
```

#### **Emergency Recovery Procedures**

**If operations fail mid-execution:**

1. **Check for safety snapshots:**
   ```bash
   git stash list
   git worktree list
   ```

2. **Restore working directory:**
   ```bash
   # From stash
   git stash pop stash@{0}
   
   # From worktree (copy files manually)
   cp -r .git/worktrees/mcp-safety-*/. .
   ```

3. **Reset to known good state:**
   ```bash
   # Soft reset (keeps changes)
   git reset --soft HEAD~1
   
   # Mixed reset (unstages changes)
   git reset HEAD~1
   ```

4. **Clean up safely:**
   ```bash
   # Remove untracked files
   git clean -fd
   
   # Reset modified files
   git checkout -- .
   ```

## Quickstart Tutorial

### Complete Workflow Example

Follow this step-by-step example to experience the full MCP Git Orchestrator workflow:

#### **Step 1: Initial Setup**

```bash
# 1. Start the MCP server
pnpm serve

# 2. In Cursor, configure the MCP server (see installation above)

# 3. Open a Git repository in Cursor
# 4. Open the MCP panel and verify tools are available
```

#### **Step 2: Repository Analysis**

Use these MCP tools in Cursor:

```json
// 1. Get repository overview
{
  "tool": "repo_overview",
  "args": {}
}
// Expected output: Current branch, remote status, ahead/behind commits

// 2. Check working directory status
{
  "tool": "status",
  "args": {}
}
// Expected output: Staged, unstaged, and untracked files

// 3. View changes (if any)
{
  "tool": "diff",
  "args": {
    "scope": "unstaged"
  }
}
// Expected output: Detailed diff of unstaged changes
```

#### **Step 3: Make Changes**

Create a new feature:

```bash
# Outside of MCP - make some changes to your code
echo "export const newFeature = () => 'Hello World';" > src/feature.ts
echo "import { newFeature } from './feature'; console.log(newFeature());" >> src/index.ts
```

#### **Step 4: Plan and Review**

```json
// 1. Check status again
{
  "tool": "status",
  "args": {}
}

// 2. View the changes
{
  "tool": "diff",
  "args": {
    "scope": "unstaged"
  }
}

// 3. Propose a commit message
{
  "tool": "propose_commit",
  "args": {
    "changed_files": ["src/feature.ts", "src/index.ts"],
    "include_analysis": true
  }
}
// Expected output: Intelligent commit message like "feat(core): add new feature functionality"
```

#### **Step 5: Dry-Run the Workflow**

```json
// Test the complete workflow safely
{
  "tool": "dry_run",
  "args": {
    "plan": [
      {
        "operation": "stage",
        "args": {
          "paths": ["src/feature.ts", "src/index.ts"]
        },
        "description": "Stage new feature files"
      },
      {
        "operation": "commit",
        "args": {
          "message": "feat(core): add new feature functionality"
        },
        "description": "Commit the new feature",
        "dependencies": [0]
      }
    ],
    "fail_fast": false,
    "include_suggestions": true
  }
}
// Expected output: Execution transcript, risk analysis, rollback instructions
```

#### **Step 6: Execute the Plan**

If dry-run looks good, execute the operations:

```json
// 1. Stage the files
{
  "tool": "stage",
  "args": {
    "paths": ["src/feature.ts", "src/index.ts"]
  }
}

// 2. Commit the changes
{
  "tool": "commit",
  "args": {
    "message": "feat(core): add new feature functionality"
  }
}

// 3. Push to remote (optional)
{
  "tool": "push",
  "args": {
    "remote": "origin",
    "branch": "feature/new-feature"
  }
}
```

#### **Step 7: Create Pull Request (GitHub Integration)**

```json
// If GITHUB_TOKEN is configured
{
  "tool": "pr_create",
  "args": {
    "title": "feat(core): add new feature functionality",
    "body": "This PR adds a new feature that provides Hello World functionality to the core module.",
    "head": "feature/new-feature",
    "base": "main",
    "labels": ["feature", "enhancement"],
    "reviewers": ["team-lead"]
  }
}
// Expected output: PR URL, number, diffstat, CI status
```

### Advanced Workflow: Conflict Resolution

#### **Scenario: Merge Conflict Resolution**

```json
// 1. Analyze potential conflicts before merging
{
  "tool": "merge",
  "args": {
    "target": "main",
    "strategy": "merge",
    "detailed_analysis": true
  }
}
// Output: Conflict forecast, risk assessment, recommendations

// 2. If conflicts detected, map them
{
  "tool": "conflict_map",
  "args": {
    "include_suggestions": true,
    "include_content": true
  }
}
// Output: Detailed conflict analysis with resolution priorities

// 3. Use dry-run to test conflict resolution
{
  "tool": "dry_run",
  "args": {
    "plan": [
      {
        "operation": "merge",
        "args": {
          "target": "main"
        }
      }
    ],
    "use_worktree": true
  }
}
// Safe testing of merge operation
```

### GitHub Integration (Optional)

The MCP Git Orchestrator includes optional GitHub integration for pull request creation. To enable:

1. **Create a GitHub Personal Access Token:**
   - Go to GitHub Settings → Developer settings → Personal access tokens
   - Create a token with `repo` scope for private repositories
   - For public repositories, `public_repo` scope is sufficient

2. **Set the Environment Variable:**
   ```bash
   export GITHUB_TOKEN=your_token_here
   ```

3. **Available Features:**
   - **Pull Request Creation**: Create PRs with automated diffstat and CI status
   - **Policy Integration**: Respects repository policies for base branches
   - **Rich Descriptions**: Auto-generated PR bodies with change summaries
   - **Label & Reviewer Support**: Assign labels, reviewers, and assignees
   - **Draft PR Support**: Create draft PRs for work-in-progress features

**Example Usage:**
```bash
# Create a simple PR
mcp-git pr_create --title "feat: add new feature" --body "Detailed description"

# Create a draft PR with reviewers
mcp-git pr_create --title "wip: new feature" --draft --reviewers="reviewer1,reviewer2"

# Create PR targeting specific branch
mcp-git pr_create --title "hotfix: critical bug" --base="release" --labels="hotfix,critical"
```

## Architecture

```
mcp-git-orchestrator/
├── packages/
│   ├── server/                    # Core MCP server
│   │   ├── src/
│   │   │   ├── tools/            # Git operation tools
│   │   │   │   ├── repo_overview.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── diff.ts
│   │   │   │   ├── propose_commit.ts
│   │   │   │   ├── stage.ts
│   │   │   │   ├── commit.ts
│   │   │   │   ├── push.ts
│   │   │   │   ├── branch.ts
│   │   │   │   ├── merge.ts
│   │   │   │   ├── conflict_map.ts
│   │   │   │   ├── dry_run.ts
│   │   │   │   └── pr_create.ts
│   │   │   ├── git/              # Safe Git execution layer
│   │   │   │   ├── exec.ts       # Allowlist-based Git runner
│   │   │   │   └── parse.ts      # Git output parsers
│   │   │   ├── policy/           # Policy loading and validation
│   │   │   │   ├── defaults.ts   # Default policy values
│   │   │   │   └── loadPolicy.ts # YAML policy loader
│   │   │   ├── adapters/         # External service integrations
│   │   │   │   └── github.ts     # GitHub API integration
│   │   │   └── types.ts          # TypeScript interfaces
│   │   └── __tests__/            # Comprehensive test suite
│   │       ├── acceptance.test.ts # End-to-end tests
│   │       └── tools/            # Tool-specific tests
│   └── cli/                      # Command-line interface
│       ├── src/index.ts          # CLI implementation
│       └── dist/                 # Built CLI
├── .ai-vcs-policy.yaml           # Example policy configuration
└── pnpm-workspace.yaml           # Monorepo configuration
```

### Key Components

- **Git Executor**: Allowlist-based command execution with timeout protection
- **Policy System**: Flexible configuration for AI behavior constraints
- **Tool System**: Modular Git operations with consistent interfaces
- **Safety Layer**: Automatic snapshots and rollback capabilities
- **Conflict Analysis**: Advanced conflict detection and resolution guidance
- **GitHub Integration**: Optional PR creation and management

## Development

### Commands

```bash
# Development mode (watch)
pnpm dev

# Run tests
pnpm test

# Run acceptance tests
pnpm test:acceptance

# Run specific tool tests
pnpm test packages/server/src/tools/__tests__/

# Build for production
pnpm build

# Clean build artifacts
pnpm clean
```

### Testing Strategy

The project includes multiple levels of testing:

- **Unit Tests**: Individual tool testing with mocked Git operations
- **Integration Tests**: Tool interaction and workflow validation
- **Acceptance Tests**: End-to-end scenarios with real Git repositories
- **Policy Tests**: Configuration validation and enforcement
- **Safety Tests**: Error handling and recovery mechanisms

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run acceptance tests only
pnpm test:acceptance

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

## Configuration

### Environment Variables

- `MCP_GIT_VERBOSE`: Enable verbose logging (set to "1")
- `MCP_GIT_POLICY_PATH`: Custom path to policy file
- `MCP_GIT_TIMEOUT`: Default operation timeout (seconds)
- `GITHUB_TOKEN`: GitHub personal access token (enables `pr_create` tool)

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

## Use Cases

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

## API Reference

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

### Tool-Specific Examples

#### **repo_overview**
```json
{
  "success": true,
  "data": {
    "root": "/path/to/repo",
    "branch": "feature/auth",
    "head": "abc123",
    "remotes": [{"name": "origin", "url": "https://github.com/user/repo.git"}],
    "aheadBehind": {"ahead": 2, "behind": 0}
  },
  "summary": "On feature/auth, 2 commits ahead of origin/main"
}
```

#### **dry_run**
```json
{
  "success": true,
  "data": {
    "planValid": true,
    "transcript": [
      {
        "step": 0,
        "operation": {"operation": "stage", "args": {"paths": ["src/"]}},
        "status": "success",
        "output": "Staged 5 files",
        "duration": 245,
        "timestamp": "2024-01-01T10:00:00Z"
      }
    ],
    "summary": {
      "totalSteps": 3,
      "successfulSteps": 3,
      "riskLevel": "low",
      "recommendedActions": ["Plan appears safe to execute"]
    },
    "rollbackInstructions": ["git reset HEAD", "git stash pop"]
  },
  "summary": "Plan executed: 3/3 steps successful, Risk: low"
}
```

## Contributing

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
- Test with real repositories using acceptance tests

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.