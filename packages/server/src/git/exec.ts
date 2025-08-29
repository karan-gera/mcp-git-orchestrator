/**
 * Safe Git Command Executor
 * 
 * Provides a secure allowlist-based Git command runner that prevents
 * destructive operations while enabling safe Git workflows.
 */

import { spawn } from 'child_process';
import type { 
  AllowedGitCommand, 
  GitExecOptions, 
  GitExecResult, 
  SafetySnapshot 
} from '../types.js';

// Allowlist of safe Git commands
const ALLOWED_COMMANDS: Set<AllowedGitCommand> = new Set([
  'status',
  'diff', 
  'add',
  'commit',
  'branch',
  'switch',
  'checkout',
  'fetch',
  'rebase',
  'merge',
  'push',
  'stash',
  'rev-parse',
  'log',
  'show',
  'ls-files',
  'symbolic-ref',
  'remote'
]);

// Banned argument patterns for extra safety
const BANNED_PATTERNS = [
  /--force$/,
  /^--force=/,
  /--hard$/,
  /^--hard=/,
  /--delete$/,
  /^--delete=/,
  /push.*--force/,
  /reset.*--hard/,
  /reflog.*delete/,
  /gc.*--aggressive/,
  /prune.*--expire=now/
];

export class GitExecutor {
  private readonly gitBinary: string;
  private readonly defaultOptions: Required<GitExecOptions>;

  constructor(gitBinary = 'git', defaultOptions: Partial<GitExecOptions> = {}) {
    this.gitBinary = gitBinary;
    this.defaultOptions = {
      cwd: process.cwd(),
      timeout: 30000, // 30 seconds
      env: process.env as Record<string, string>,
      input: '',
      ...defaultOptions
    };
  }

  /**
   * Execute a Git command with safety checks
   */
  async exec(
    command: AllowedGitCommand,
    args: string[] = [],
    options: GitExecOptions = {}
  ): Promise<GitExecResult> {
    // Validate command is allowed
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new GitError(
        1,
        `Git command '${command}' is not allowed`,
        `Command '${command}' is not in the allowlist`,
        `git ${command} ${args.join(' ')}`
      );
    }

    // Check for banned patterns in arguments
    const fullCommand = `git ${command} ${args.join(' ')}`;
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(fullCommand)) {
        throw new GitError(
          1,
          `Git command contains banned pattern: ${pattern}`,
          `Command rejected for safety: ${fullCommand}`,
          fullCommand
        );
      }
    }

    // Additional safety checks for specific commands
    this.validateCommandSafety(command, args);

    const execOptions = { ...this.defaultOptions, ...options };
    
    try {
      return await this.executeCommand(command, args, execOptions);
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      
      throw new GitError(
        -1,
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.message : 'Unknown error occurred',
        fullCommand
      );
    }
  }

  /**
   * Execute Git command and return parsed result
   */
  private async executeCommand(
    command: AllowedGitCommand,
    args: string[],
    options: Required<GitExecOptions>
  ): Promise<GitExecResult> {
    const fullArgs = [command, ...args];
    const commandString = `git ${fullArgs.join(' ')}`;

    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBinary, fullArgs, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: options.timeout
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      if (options.input) {
        child.stdin?.write(options.input);
        child.stdin?.end();
      }

      child.on('close', (code) => {
        const result: GitExecResult = {
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code || 0,
          command: commandString
        };

        if (code !== 0) {
          reject(new GitError(
            code || 1,
            `Git command failed: ${commandString}`,
            stderr.trim(),
            commandString
          ));
        } else {
          resolve(result);
        }
      });

      child.on('error', (error) => {
        reject(new GitError(
          -1,
          `Failed to execute git command: ${error.message}`,
          error.message,
          commandString
        ));
      });

      child.on('timeout', () => {
        child.kill();
        reject(new GitError(
          124, // SIGTERM exit code
          `Git command timed out after ${options.timeout}ms`,
          `Command timed out: ${commandString}`,
          commandString
        ));
      });
    });
  }

  /**
   * Additional safety validation for specific commands
   */
  private validateCommandSafety(command: AllowedGitCommand, args: string[]): void {
    switch (command) {
      case 'push':
        // Never allow force push
        if (args.includes('--force') || args.includes('-f')) {
          throw new GitError(
            1,
            'Force push is not allowed',
            'Force push operations are banned for safety',
            `git push ${args.join(' ')}`
          );
        }
        break;

      case 'rebase':
        // Prevent dangerous rebase operations
        if (args.includes('--onto') && args.includes('--root')) {
          throw new GitError(
            1,
            'Root rebase operations are not allowed',
            'Root rebase with --onto is potentially destructive',
            `git rebase ${args.join(' ')}`
          );
        }
        break;

      case 'branch':
        // Prevent force deletion of branches
        if (args.includes('-D')) {
          throw new GitError(
            1,
            'Force branch deletion is not allowed',
            'Use -d for safe branch deletion only',
            `git branch ${args.join(' ')}`
          );
        }
        break;

      case 'stash':
        // Prevent stash drop without confirmation
        if (args.includes('drop') && !args.includes('--')) {
          console.warn('Warning: stash drop operation detected');
        }
        break;
    }
  }

  /**
   * Create a safety snapshot before risky operations
   */
  async createSafetySnapshot(
    type: 'worktree' | 'stash' = 'stash',
    message = 'Safety snapshot before risky operation'
  ): Promise<SafetySnapshot> {
    const timestamp = new Date().toISOString();
    
    if (type === 'stash') {
      await this.exec('stash', ['push', '-u', '-m', `${message} - ${timestamp}`]);
      
      // Get the stash ref
      const stashRef = await this.exec('rev-parse', ['stash@{0}']);
      
      return {
        type: 'stash',
        ref: stashRef.stdout,
        restoreCommand: 'git stash pop',
        createdAt: timestamp
      };
    } else {
      // Create worktree snapshot
      const currentBranch = await this.exec('symbolic-ref', ['--short', 'HEAD']);
      const snapshotPath = `../safety-snapshot-${Date.now()}`;
      
      await this.exec('branch', ['--copy', currentBranch.stdout, `snapshot-${Date.now()}`]);
      
      return {
        type: 'worktree',
        ref: currentBranch.stdout,
        path: snapshotPath,
        restoreCommand: `git worktree remove ${snapshotPath}`,
        createdAt: timestamp
      };
    }
  }

  /**
   * Check if Git repository exists and is valid
   */
  async isValidRepository(path?: string): Promise<boolean> {
    try {
      const options = path ? { cwd: path } : {};
      await this.exec('rev-parse', ['--git-dir'], options);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the repository root path
   */
  async getRepositoryRoot(path?: string): Promise<string> {
    const options = path ? { cwd: path } : {};
    const result = await this.exec('rev-parse', ['--show-toplevel'], options);
    return result.stdout;
  }
}

// Singleton instance for the module
export const gitExec = new GitExecutor();

// Custom error class for Git operations
export class GitError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly stderr: string,
    public readonly command: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}
