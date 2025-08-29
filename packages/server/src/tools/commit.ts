/**
 * Commit Tool
 * 
 * Executes Git commits with comprehensive policy validation,
 * safety checks, and conventional commit enforcement.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitStatus } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { CommitResult, CommitOptions } from '../types.js';

export interface CommitArgs extends CommitOptions {
  /** Dry run mode - validate without committing */
  dry_run?: boolean;
  /** Skip all hooks */
  skip_hooks?: boolean;
  /** Include all unstaged files in commit */
  include_all?: boolean;
}

export class CommitTool extends BaseTool {
  constructor() {
    super('commit');
  }

  getDescription(): string {
    return 'Execute Git commits with policy validation and safety checks';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message (required)',
          minLength: 1
        },
        sign: {
          type: 'boolean',
          description: 'GPG sign the commit',
          default: false
        },
        noVerify: {
          type: 'boolean',
          description: 'Skip pre-commit and commit-msg hooks',
          default: false
        },
        amend: {
          type: 'boolean',
          description: 'Amend the previous commit',
          default: false
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate without actually committing',
          default: false
        },
        skip_hooks: {
          type: 'boolean', 
          description: 'Skip all Git hooks',
          default: false
        },
        include_all: {
          type: 'boolean',
          description: 'Stage all modified files before committing',
          default: false
        }
      },
      required: ['message']
    };
  }

  async execute(args: CommitArgs, context?: ToolContext): Promise<ToolResult<CommitResult>> {
    const {
      message,
      sign = false,
      noVerify = false,
      amend = false,
      dry_run = false,
      skip_hooks = false,
      include_all = false
    } = args;

    try {
      const repositoryPath = this.getRepositoryPath(context);
      const execOptions = { cwd: repositoryPath };

      // Check if we're in a Git repository
      const isValidRepo = await gitExec.isValidRepository(repositoryPath);
      if (!isValidRepo) {
        return createErrorResult(
          'Not a Git repository',
          undefined,
          { repositoryPath }
        );
      }

      // Load policy for validation
      const policyResult = await policyLoader.loadPolicy(repositoryPath);
      const policy = policyResult.policy;

      // Validate commit message against policy
      const messageValidation = policyLoader.validateCommitMessage(policy, message);
      if (!messageValidation.valid) {
        return createErrorResult(
          `Commit message validation failed: ${messageValidation.errors.join(', ')}`,
          undefined,
          { 
            policyErrors: messageValidation.errors,
            message,
            policy: policy.commit_style
          }
        );
      }

      // Get current status
      const status = await this.getStatus(execOptions);
      
      // Pre-commit validations
      const validation = await this.validateCommit(status, policy, amend, include_all);
      if (!validation.valid) {
        return createErrorResult(
          validation.errors.join(', '),
          undefined,
          { validationErrors: validation.errors, status }
        );
      }

      if (dry_run) {
        // Dry run mode - just validate and return what would happen
        const mockResult: CommitResult = {
          sha: 'dry-run-sha',
          message,
          author: 'Current User <user@example.com>',
          date: new Date().toISOString()
        };

        return createSuccessResult(
          mockResult,
          `Would commit with message: "${message}" (dry run)`,
          { 
            repositoryPath, 
            dryRun: true,
            validation,
            stagedFiles: status.staged.length,
            messageValidation
          }
        );
      }

      // Create safety snapshot before committing
      if (policy.safety_snapshots.auto_create && 
          policy.safety_snapshots.trigger_operations.includes('commit')) {
        await gitExec.createSafetySnapshot('stash', 'Before commit operation');
      }

      // Stage all files if requested
      if (include_all && status.unstaged.length > 0) {
        await gitExec.exec('add', ['-A'], execOptions);
      }

      // Build commit command arguments
      const commitArgs = this.buildCommitArgs({
        message,
        sign,
        noVerify: noVerify || skip_hooks,
        amend
      });

      // Execute the commit
      const commitResult = await gitExec.exec('commit', commitArgs, execOptions);
      
      // Parse commit result
      const result = await this.parseCommitResult(commitResult.stdout, execOptions);

      const metadata = {
        repositoryPath,
        operation: amend ? 'amend' : 'commit',
        messageValidation,
        validation,
        hooks: {
          skipped: noVerify || skip_hooks,
          respected: policy.repository.respect_hooks && !noVerify && !skip_hooks
        },
        safety: {
          snapshotCreated: policy.safety_snapshots.auto_create,
          includeAll: include_all
        },
        beforeStatus: status,
        afterStatus: await this.getStatus(execOptions)
      };

      const summary = this.generateSummary(result, metadata);

      return createSuccessResult(result, summary, metadata);

    } catch (error) {
      const errorMessage = error instanceof GitError 
        ? `Git error: ${error.message}` 
        : error instanceof Error 
        ? error.message 
        : 'Unknown error occurred';

      return createErrorResult(errorMessage);
    }
  }

  /**
   * Get current Git status
   */
  private async getStatus(execOptions: any) {
    const statusResult = await gitExec.exec('status', ['--porcelain=v1'], execOptions);
    return parseGitStatus(statusResult.stdout);
  }

  /**
   * Validate commit operation
   */
  private async validateCommit(
    status: any,
    policy: any,
    amend: boolean,
    includeAll: boolean
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if there are changes to commit
    if (!amend && status.staged.length === 0 && !includeAll) {
      errors.push('No staged changes to commit. Use include_all or stage files first.');
    }

    if (!amend && status.staged.length === 0 && includeAll && status.unstaged.length === 0) {
      errors.push('No changes to commit.');
    }

    // Check for unmerged files
    const unmergedFiles = status.staged.filter((f: any) => f.status === 'unmerged');
    if (unmergedFiles.length > 0) {
      errors.push(`Cannot commit with unmerged files: ${unmergedFiles.map((f: any) => f.path).join(', ')}`);
    }

    // Policy-specific validations
    if (includeAll && policy.commit_style.enforce_conventional) {
      warnings.push('Including all files - ensure commit message covers all changes');
    }

    if (status.unstaged.length > 0 && !includeAll) {
      warnings.push(`${status.unstaged.length} unstaged files will not be included in commit`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Build commit command arguments
   */
  private buildCommitArgs(options: CommitOptions): string[] {
    const args: string[] = [];

    // Message
    args.push('-m', options.message);

    // Optional flags
    if (options.sign) {
      args.push('-S');
    }

    if (options.noVerify) {
      args.push('--no-verify');
    }

    if (options.amend) {
      args.push('--amend');
    }

    return args;
  }

  /**
   * Parse commit result from Git output
   */
  private async parseCommitResult(output: string, execOptions: any): Promise<CommitResult> {
    // Extract commit SHA from output (usually in format: [branch sha] message)
    const shaMatch = output.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
    const sha = shaMatch ? shaMatch[1] : 'unknown';

    // Get detailed commit info
    try {
      const logResult = await gitExec.exec('log', ['-1', '--format=%H%n%s%n%an <%ae>%n%ai'], execOptions);
      const [fullSha, subject, author, date] = logResult.stdout.split('\n');

      return {
        sha: fullSha || sha,
        message: subject || 'Unknown message',
        author: author || 'Unknown author',
        date: date || new Date().toISOString()
      };
    } catch {
      // Fallback if log command fails
      return {
        sha,
        message: 'Unknown message',
        author: 'Unknown author',
        date: new Date().toISOString()
      };
    }
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: CommitResult, metadata: any): string {
    const parts: string[] = [];
    
    const operation = metadata.operation === 'amend' ? 'Amended commit' : 'Created commit';
    parts.push(`${operation} ${result.sha.slice(0, 8)}`);

    if (result.message.length > 50) {
      parts.push(`"${result.message.slice(0, 47)}..."`);
    } else {
      parts.push(`"${result.message}"`);
    }

    if (metadata.safety?.snapshotCreated) {
      parts.push('(with safety snapshot)');
    }

    if (metadata.hooks?.skipped) {
      parts.push('(hooks skipped)');
    }

    return parts.join(' ');
  }
}
