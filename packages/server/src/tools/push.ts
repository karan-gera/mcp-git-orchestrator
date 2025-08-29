/**
 * Push Tool
 * 
 * Executes Git push operations with protected branch enforcement,
 * pre-push checks, and comprehensive safety validation.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { PushResult, PushOptions, PrepushCheck } from '../types.js';
import { spawn } from 'child_process';

export interface PushArgs extends PushOptions {
  /** Dry run mode - show what would be pushed without doing it */
  dry_run?: boolean;
  /** Danger mode - allow pushes to protected branches with explicit confirmation */
  danger_mode?: boolean;
  /** Explicit confirmation string for protected branch pushes */
  confirm?: string;
  /** Skip pre-push checks */
  skip_checks?: boolean;
}

interface CheckResult {
  name: string;
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
}

export class PushTool extends BaseTool {
  constructor() {
    super('push');
  }

  getDescription(): string {
    return 'Execute Git push operations with protected branch enforcement and pre-push checks';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        remote: {
          type: 'string',
          description: 'Remote name (default: origin)',
          default: 'origin'
        },
        branch: {
          type: 'string',
          description: 'Branch name (default: current branch)'
        },
        setUpstream: {
          type: 'boolean',
          description: 'Set upstream for the branch',
          default: false
        },
        dry_run: {
          type: 'boolean',
          description: 'Show what would be pushed without doing it',
          default: false
        },
        danger_mode: {
          type: 'boolean',
          description: 'Allow pushes to protected branches with explicit confirmation',
          default: false
        },
        confirm: {
          type: 'string',
          description: 'Explicit confirmation string (required for protected branch pushes)'
        },
        skip_checks: {
          type: 'boolean',
          description: 'Skip pre-push validation checks',
          default: false
        }
      }
    };
  }

  async execute(args: PushArgs = {}, context?: ToolContext): Promise<ToolResult<PushResult>> {
    const {
      remote = 'origin',
      branch,
      setUpstream = false,
      dry_run = false,
      danger_mode = false,
      confirm,
      skip_checks = false
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

      // Get current branch if not specified
      const currentBranch = branch || await this.getCurrentBranch(execOptions);
      
      // Check if pushing to protected branch
      const isProtected = policyLoader.isBranchProtected(policy, currentBranch);
      if (isProtected) {
        if (!danger_mode) {
          return createErrorResult(
            `Branch '${currentBranch}' is protected. Use danger_mode=true with explicit confirmation to override.`,
            undefined,
            { 
              protectedBranch: currentBranch,
              protectedBranches: policy.protected_branches,
              dangerModeRequired: true
            }
          );
        }

        if (!confirm) {
          return createErrorResult(
            `Protected branch push requires explicit confirmation. Provide confirm parameter.`,
            undefined,
            { 
              protectedBranch: currentBranch,
              confirmationRequired: true,
              expectedConfirm: `DANGER: Push to protected branch ${currentBranch}`
            }
          );
        }

        const expectedConfirm = `DANGER: Push to protected branch ${currentBranch}`;
        if (confirm !== expectedConfirm) {
          return createErrorError(
            `Invalid confirmation. Expected: "${expectedConfirm}"`,
            undefined,
            { 
              protectedBranch: currentBranch,
              providedConfirm: confirm,
              expectedConfirm
            }
          );
        }
      }

      // Check for unpushed commits
      const unpushedCommits = await this.getUnpushedCommits(remote, currentBranch, execOptions);
      if (unpushedCommits.length === 0 && !dry_run) {
        return createSuccessResult(
          {
            remote,
            branch: currentBranch,
            outcome: 'up-to-date',
            summary: 'Everything up-to-date'
          },
          `Branch '${currentBranch}' is already up-to-date with ${remote}`,
          { repositoryPath, unpushedCommits: [] }
        );
      }

      // Run pre-push checks unless skipped
      let checkResults: CheckResult[] = [];
      if (!skip_checks && !dry_run) {
        const checksToRun = policyLoader.getPrepushChecks(policy, false); // Get all checks, not just required
        if (checksToRun.length > 0) {
          checkResults = await this.runPrepushChecks(checksToRun, repositoryPath);
          
          // Check if any required checks failed
          const failedRequiredChecks = checkResults.filter(result => 
            !result.success && checksToRun.find(check => check.name === result.name)?.required
          );

          if (failedRequiredChecks.length > 0) {
            return createErrorResult(
              `Required pre-push checks failed: ${failedRequiredChecks.map(c => c.name).join(', ')}`,
              undefined,
              { 
                failedChecks: failedRequiredChecks,
                allCheckResults: checkResults,
                protectedBranch: isProtected
              }
            );
          }
        }
      }

      if (dry_run) {
        // Dry run mode - show what would be pushed
        return createSuccessResult(
          {
            remote,
            branch: currentBranch,
            outcome: 'success',
            summary: `Would push ${unpushedCommits.length} commits to ${remote}/${currentBranch}`
          },
          `Would push ${unpushedCommits.length} ${this.pluralize('commit', unpushedCommits.length)} (dry run)`,
          { 
            repositoryPath, 
            dryRun: true,
            unpushedCommits,
            checkResults: skip_checks ? [] : checkResults,
            protectedBranch: isProtected
          }
        );
      }

      // Create safety snapshot before pushing
      if (policy.safety_snapshots.auto_create && 
          policy.safety_snapshots.trigger_operations.includes('push')) {
        await gitExec.createSafetySnapshot('stash', 'Before push operation');
      }

      // Build push command arguments
      const pushArgs = this.buildPushArgs({
        remote,
        branch: currentBranch,
        setUpstream,
        force: false // Never allow force push
      });

      // Execute the push
      const pushResult = await gitExec.exec('push', pushArgs, execOptions);
      
      // Parse push result
      const result = this.parsePushResult(pushResult.stdout, pushResult.stderr, {
        remote,
        branch: currentBranch
      });

      const metadata = {
        repositoryPath,
        protectedBranch: isProtected,
        dangerMode: danger_mode && isProtected,
        checkResults,
        unpushedCommits,
        safety: {
          snapshotCreated: policy.safety_snapshots.auto_create,
          checksRun: !skip_checks
        }
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
   * Get current branch name
   */
  private async getCurrentBranch(execOptions: any): Promise<string> {
    try {
      const result = await gitExec.exec('symbolic-ref', ['--short', 'HEAD'], execOptions);
      return result.stdout.trim();
    } catch {
      // Detached HEAD
      const result = await gitExec.exec('rev-parse', ['--short', 'HEAD'], execOptions);
      return `detached@${result.stdout.trim()}`;
    }
  }

  /**
   * Get unpushed commits
   */
  private async getUnpushedCommits(remote: string, branch: string, execOptions: any): Promise<string[]> {
    try {
      const result = await gitExec.exec('log', [`${remote}/${branch}..HEAD`, '--oneline'], execOptions);
      return result.stdout.trim() ? result.stdout.split('\n') : [];
    } catch {
      // Branch might not exist on remote yet
      const result = await gitExec.exec('log', ['--oneline'], execOptions);
      return result.stdout.trim() ? result.stdout.split('\n') : [];
    }
  }

  /**
   * Run pre-push checks
   */
  private async runPrepushChecks(checks: PrepushCheck[], repositoryPath: string): Promise<CheckResult[]> {
    const results: CheckResult[] = [];

    for (const check of checks) {
      const startTime = Date.now();
      
      try {
        const result = await this.runSingleCheck(check, repositoryPath);
        results.push({
          name: check.name,
          success: result.exitCode === 0,
          output: result.stdout,
          error: result.stderr,
          exitCode: result.exitCode,
          duration: Date.now() - startTime
        });
      } catch (error) {
        results.push({
          name: check.name,
          success: false,
          output: '',
          error: error instanceof Error ? error.message : 'Unknown error',
          exitCode: -1,
          duration: Date.now() - startTime
        });
      }
    }

    return results;
  }

  /**
   * Run a single pre-push check
   */
  private async runSingleCheck(check: PrepushCheck, repositoryPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const workingDir = check.cwd ? `${repositoryPath}/${check.cwd}` : repositoryPath;
      
      // Parse command and arguments
      const [command, ...args] = check.command.split(' ');
      
      const child = spawn(command, args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: check.timeout * 1000,
        shell: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code || 0
        });
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('timeout', () => {
        child.kill();
        reject(new Error(`Check '${check.name}' timed out after ${check.timeout} seconds`));
      });
    });
  }

  /**
   * Build push command arguments
   */
  private buildPushArgs(options: { remote: string; branch: string; setUpstream: boolean; force: boolean }): string[] {
    const args: string[] = [];

    // Remote and branch
    args.push(options.remote);
    args.push(options.branch);

    // Set upstream
    if (options.setUpstream) {
      args.push('--set-upstream');
    }

    // Force is explicitly not supported for safety
    // force push is blocked by the allowlist in GitExecutor

    return args;
  }

  /**
   * Parse push result from Git output
   */
  private parsePushResult(stdout: string, stderr: string, context: { remote: string; branch: string }): PushResult {
    // Determine outcome from output
    let outcome: 'success' | 'rejected' | 'up-to-date' = 'success';
    let summary = stdout + stderr;

    if (summary.includes('Everything up-to-date')) {
      outcome = 'up-to-date';
    } else if (summary.includes('rejected') || summary.includes('error')) {
      outcome = 'rejected';
    }

    return {
      remote: context.remote,
      branch: context.branch,
      outcome,
      summary: summary.trim()
    };
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: PushResult, metadata: any): string {
    const parts: string[] = [];

    switch (result.outcome) {
      case 'success':
        parts.push(`Pushed to ${result.remote}/${result.branch}`);
        if (metadata.unpushedCommits?.length > 0) {
          parts.push(`(${metadata.unpushedCommits.length} ${this.pluralize('commit', metadata.unpushedCommits.length)})`);
        }
        break;
      case 'up-to-date':
        parts.push(`${result.branch} is up-to-date with ${result.remote}`);
        break;
      case 'rejected':
        parts.push(`Push to ${result.remote}/${result.branch} was rejected`);
        break;
    }

    if (metadata.protectedBranch && metadata.dangerMode) {
      parts.push('⚠️ Protected branch');
    }

    if (metadata.checkResults?.length > 0) {
      const failedChecks = metadata.checkResults.filter((r: CheckResult) => !r.success);
      if (failedChecks.length > 0) {
        parts.push(`${failedChecks.length} check${failedChecks.length !== 1 ? 's' : ''} failed`);
      } else {
        parts.push(`${metadata.checkResults.length} checks passed`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Simple pluralization helper
   */
  private pluralize(word: string, count: number): string {
    return count === 1 ? word : `${word}s`;
  }
}

// Fix typo in error function name
function createErrorError(message: string, data?: any, metadata?: any) {
  return createErrorResult(message, data, metadata);
}
