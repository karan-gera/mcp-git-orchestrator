# mcp-git-orchestrator

> Local-first Model Context Protocol (MCP) server for safe, structured Git control

## Overview

A TypeScript-based MCP server that provides AI agents with safe, structured control over Git operations. Features stateless design, comprehensive safety mechanisms, and conventional commit workflows.

## Quick Start

```bash
# Install dependencies
pnpm install

# Development mode
pnpm dev

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Architecture

- **Server Package**: Core MCP server implementation
- **CLI Package**: Command-line interface for server management

## Safety Features

- No destructive Git operations (no `reset --hard`, `push --force`)
- Automatic safety snapshots before risky operations
- Stateless operation design
- Comprehensive conflict detection and resolution

## License

MIT
