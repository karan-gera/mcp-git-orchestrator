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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

program
  .name('mcp-git')
  .description('CLI for MCP Git Orchestrator server')
  .version('0.1.0');

program
  .command('serve')
  .description('Start the MCP server in stdio mode')
  .action(async () => {
    console.log('Starting MCP Git Orchestrator server...');
    
    // Path to the server package
    const serverPath = join(__dirname, '..', '..', 'server', 'dist', 'index.js');
    
    try {
      // Start the server as a child process
      const serverProcess = spawn('node', [serverPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: process.cwd()
      });

      serverProcess.on('error', (error) => {
        console.error('Failed to start server:', error.message);
        process.exit(1);
      });

      serverProcess.on('exit', (code) => {
        console.log(`Server exited with code ${code}`);
        process.exit(code || 0);
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log('Shutting down server...');
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
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log('MCP Git Orchestrator CLI v0.1.0');
    console.log('Server: @mcp-git-orchestrator/server v0.1.0');
  });

program.parse();
