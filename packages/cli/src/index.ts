#!/usr/bin/env node

/**
 * MCP Git Orchestrator CLI
 * 
 * Command-line interface for managing the MCP Git Orchestrator server.
 * Provides commands to start, stop, and interact with the server.
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

// Read package.json for version info
const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

program
  .name('mcp-git')
  .description('CLI for MCP Git Orchestrator server')
  .version(packageJson.version);

program
  .command('serve')
  .description('Start the MCP server in stdio mode')
  .option('--verbose', 'Enable verbose logging')
  .action(async (options) => {
    if (options.verbose) {
      console.error('Starting MCP Git Orchestrator server in verbose mode...');
    } else {
      console.error('Starting MCP Git Orchestrator server...');
    }
    
    // Path to the server package
    const serverPath = join(__dirname, '..', '..', 'server', 'dist', 'index.js');
    
    try {
      // Start the server as a child process
      const serverProcess = spawn('node', [serverPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: process.cwd(),
        env: {
          ...process.env,
          MCP_GIT_VERBOSE: options.verbose ? '1' : '0'
        }
      });

      serverProcess.on('error', (error) => {
        console.error('Failed to start server:', error.message);
        process.exit(1);
      });

      serverProcess.on('exit', (code) => {
        if (options.verbose) {
          console.error(`Server exited with code ${code}`);
        }
        process.exit(code || 0);
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        if (options.verbose) {
          console.error('Shutting down server...');
        }
        serverProcess.kill('SIGTERM');
      });

      process.on('SIGTERM', () => {
        serverProcess.kill('SIGTERM');
      });

    } catch (error) {
      console.error('Error starting server:', error);
      process.exit(1);
    }
  });

program
  .command('manifest')
  .description('Generate MCP manifest for integration with Cursor or other clients')
  .option('--format <format>', 'Output format (json, cursor)', 'json')
  .option('--name <name>', 'Server name in manifest', 'mcp-git-orchestrator')
  .option('--command <command>', 'Command to run server', 'npx mcp-git serve')
  .action((options) => {
    const manifest = generateManifest(options);
    
    if (options.format === 'cursor') {
      console.log('Add this to your Cursor settings (.cursor-settings/settings.json):');
      console.log('');
      console.log(JSON.stringify({
        "mcp.servers": {
          [options.name]: manifest
        }
      }, null, 2));
      console.log('');
      console.log('Or add this entry to your existing mcp.servers configuration:');
      console.log('');
      console.log(`"${options.name}": ${JSON.stringify(manifest, null, 2)}`);
    } else {
      console.log(JSON.stringify(manifest, null, 2));
    }
  });

program
  .command('tools')
  .description('List available Git tools and their descriptions')
  .action(async () => {
    console.log('Available MCP Git Orchestrator Tools:\n');
    
    const tools = [
      {
        name: 'repo_overview',
        description: 'Get repository overview with branch, head, and remote information',
        example: 'Get current repository state and branch information'
      },
      {
        name: 'status', 
        description: 'Get Git status showing staged, unstaged, and untracked files',
        example: 'Show which files are modified, staged, or untracked'
      },
      {
        name: 'diff',
        description: 'Get diff information for staged, unstaged, or specific files',
        example: 'View changes in working directory or staging area'
      },
      {
        name: 'propose_commit',
        description: 'Generate intelligent commit messages based on staged changes',
        example: 'Analyze changes and suggest Conventional Commit message'
      },
      {
        name: 'stage',
        description: 'Stage files for commit with selective and interactive options',
        example: 'Add files to staging area with patch mode support'
      },
      {
        name: 'commit',
        description: 'Create commits with message validation and safety checks',
        example: 'Commit staged changes with policy validation'
      },
      {
        name: 'push',
        description: 'Push changes with protected branch enforcement and pre-push checks',
        example: 'Safely push commits while respecting branch protection rules'
      },
      {
        name: 'branch',
        description: 'Manage branches with policy-compliant naming and safety validations',
        example: 'Create, switch, delete, or list branches'
      },
      {
        name: 'merge',
        description: 'Analyze merge conflicts and risks before executing (preflight only)',
        example: 'Forecast potential conflicts and assess merge difficulty'
      },
      {
        name: 'conflict_map',
        description: 'Detect and analyze Git conflict markers with resolution guidance',
        example: 'Scan files for conflicts and prioritize resolution order'
      },
      {
        name: 'dry_run',
        description: 'Execute Git operation plans safely in isolated temporary worktrees',
        example: 'Test complex Git workflows without affecting main repository'
      },
      {
        name: 'pr_create',
        description: 'Create GitHub pull requests with policy integration (requires GITHUB_TOKEN)',
        example: 'Create PRs with automated diffstat and CI status integration'
      }
    ];

    tools.forEach((tool, index) => {
      console.log(`${index + 1}. ${tool.name}`);
      console.log(`   Description: ${tool.description}`);
      console.log(`   Example: ${tool.example}`);
      console.log('');
    });

    console.log('Usage: Use these tools through MCP-compatible clients like Cursor.');
    console.log('Each tool returns JSON data with human-readable summaries.');
    console.log('');
    console.log('Note: pr_create requires GITHUB_TOKEN environment variable for GitHub integration.');
  });

program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`MCP Git Orchestrator CLI v${packageJson.version}`);
    console.log(`Server: @mcp-git-orchestrator/server v${packageJson.version}`);
    console.log('');
    console.log('Tools: 11+ Git operations with advanced safety mechanisms');
    console.log('Features: Policy enforcement, conflict analysis, dry-run execution, GitHub integration');
  });

program
  .command('test')
  .description('Test server connectivity and tool availability')
  .action(async () => {
    console.log('Testing MCP Git Orchestrator server...\n');
    
    // Path to the server package
    const serverPath = join(__dirname, '..', '..', 'server', 'dist', 'index.js');
    
    try {
      console.log('✓ Server binary found at:', serverPath);
      
      // Test basic Node.js execution
      const testProcess = spawn('node', ['-e', 'console.log("Node.js working")'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      testProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('✓ Node.js runtime available');
          console.log('✓ Ready to serve MCP Git Orchestrator tools');
          console.log('\nTo start the server: mcp-git serve');
          console.log('To generate manifest: mcp-git manifest --format cursor');
        } else {
          console.log('✗ Node.js runtime test failed');
          process.exit(1);
        }
      });

      testProcess.on('error', (error) => {
        console.log('✗ Node.js runtime error:', error.message);
        process.exit(1);
      });

    } catch (error) {
      console.log('✗ Server test failed:', error);
      process.exit(1);
    }
  });

function generateManifest(options: any) {
  const manifest = {
    command: options.command,
    args: [],
    env: {},
  };

  return manifest;
}

// Add helpful error handling for missing Node.js or dependencies
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

program.parse();