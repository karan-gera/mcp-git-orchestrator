/**
 * Dry Run Tool
 * 
 * Executes a plan of Git operations in isolation using a temporary worktree
 * to validate the sequence without affecting the main repository.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import type { DryRunResult, GitPlanStep, DryRunTranscript, DryRunSummary, DryRunChanges } from '../types.js';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

export interface DryRunArgs {
  /** Array of Git operations to execute in sequence */
  plan: GitPlanStep[];
  /** Whether to stop execution on first failure */
  fail_fast?: boolean;
  /** Maximum execution time in seconds */
  timeout?: number;
  /** Whether to clean up temporary worktree on completion */
  cleanup?: boolean;
  /** Custom worktree name prefix */
  worktree_prefix?: string;
}

export class DryRunTool extends BaseTool {
  constructor() {
    super('dry_run');
  }

  getDescription(): string {
    return 'Execute a plan of Git operations in isolation using temporary worktree for safe validation';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operation: {
                type: 'string',
                enum: ['stage', 'commit', 'branch', 'merge', 'push', 'pull', 'rebase', 'stash', 'reset'],
                description: 'Git operation to perform'
              },
              args: {
                type: 'object',
                description: 'Arguments for the operation'
              },
              description: {
                type: 'string',
                description: 'Human-readable description of the step'
              },
              dependencies: {
                type: 'array',
                items: { type: 'number' },
                description: 'Indices of steps this depends on'
              },
              optional: {
                type: 'boolean',
                description: 'Whether failure should stop execution',
                default: false
              }
            },
            required: ['operation', 'args']
          },
          description: 'Array of Git operations to execute',
          minItems: 1
        },
        fail_fast: {
          type: 'boolean',
          description: 'Stop execution on first failure',
          default: true
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in seconds',
          default: 300,
          minimum: 10,
          maximum: 1800
        },
        cleanup: {
          type: 'boolean',
          description: 'Clean up temporary worktree on completion',
          default: true
        },
        worktree_prefix: {
          type: 'string',
          description: 'Custom worktree name prefix',
          default: 'mcp-dry-run'
        }
      },
      required: ['plan']
    };
  }

  async execute(args: DryRunArgs, context?: ToolContext): Promise<ToolResult<DryRunResult>> {
    const {
      plan,
      fail_fast = true,
      timeout = 300,
      cleanup = true,
      worktree_prefix = 'mcp-dry-run'
    } = args;

    const startTime = Date.now();
    let worktreePath: string | null = null;
    let tempDir: string | null = null;

    try {
      const repositoryPath = this.getRepositoryPath(context);

      // Validate repository
      const isValidRepo = await gitExec.isValidRepository(repositoryPath);
      if (!isValidRepo) {
        return createErrorResult(
          'Not a Git repository',
          undefined,
          { repositoryPath }
        );
      }

      // Validate plan
      const planValidation = this.validatePlan(plan);
      if (!planValidation.valid) {
        return createErrorResult(
          `Invalid plan: ${planValidation.errors.join(', ')}`,
          undefined,
          { planValidation }
        );
      }

      // Create temporary worktree
      const worktreeResult = await this.createTemporaryWorktree(
        repositoryPath,
        worktree_prefix
      );
      worktreePath = worktreeResult.path;
      tempDir = worktreeResult.tempDir;

      // Execute plan with timeout
      const executionPromise = this.executePlan(
        plan,
        worktreePath,
        fail_fast
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timeout after ${timeout}s`)), timeout * 1000)
      );

      const transcript = await Promise.race([executionPromise, timeoutPromise]);

      // Generate summary
      const summary = this.generateSummary(transcript, Date.now() - startTime);

      // Generate rollback instructions
      const rollbackInstructions = this.generateRollbackInstructions(transcript);

      const result: DryRunResult = {
        planValid: true,
        transcript,
        summary,
        rollbackInstructions: rollbackInstructions.length > 0 ? rollbackInstructions : undefined
      };

      const metadata = {
        repositoryPath,
        worktreePath,
        executionTime: Date.now() - startTime,
        planSteps: plan.length,
        cleanup
      };

      return createSuccessResult(
        result,
        this.generateResultSummary(summary),
        metadata
      );

    } catch (error) {
      const errorMessage = error instanceof GitError 
        ? `Git error: ${error.message}` 
        : error instanceof Error 
        ? error.message 
        : 'Unknown error occurred';

      return createErrorResult(errorMessage, undefined, {
        executionTime: Date.now() - startTime,
        worktreePath,
        cleanupNeeded: !cleanup && worktreePath
      });

    } finally {
      // Clean up temporary worktree
      if (cleanup && worktreePath && tempDir) {
        try {
          await this.cleanupWorktree(worktreePath, tempDir);
        } catch (cleanupError) {
          // Log cleanup error but don't fail the operation
          console.warn('Failed to cleanup worktree:', cleanupError);
        }
      }
    }
  }

  /**
   * Validate the execution plan
   */
  private validatePlan(plan: GitPlanStep[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (plan.length === 0) {
      errors.push('Plan cannot be empty');
    }

    // Check for valid operations
    const validOperations = ['stage', 'commit', 'branch', 'merge', 'push', 'pull', 'rebase', 'stash', 'reset'];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      
      if (!validOperations.includes(step.operation)) {
        errors.push(`Step ${i}: Invalid operation '${step.operation}'`);
      }

      // Check dependencies
      if (step.dependencies) {
        for (const dep of step.dependencies) {
          if (dep >= i) {
            errors.push(`Step ${i}: Dependency ${dep} must be a previous step`);
          }
          if (dep < 0 || dep >= plan.length) {
            errors.push(`Step ${i}: Dependency ${dep} is out of bounds`);
          }
        }
      }

      // Validate specific operations
      switch (step.operation) {
        case 'commit':
          if (!step.args?.message) {
            errors.push(`Step ${i}: Commit operation requires 'message' argument`);
          }
          break;
        case 'branch':
          if (!step.args?.name && !step.args?.op) {
            errors.push(`Step ${i}: Branch operation requires 'name' or 'op' argument`);
          }
          break;
        case 'merge':
          if (!step.args?.target) {
            errors.push(`Step ${i}: Merge operation requires 'target' argument`);
          }
          break;
        case 'push':
          // Push operations are risky in dry-run, warn but allow
          break;
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Create a temporary worktree for isolated execution
   */
  private async createTemporaryWorktree(
    repositoryPath: string,
    prefix: string
  ): Promise<{ path: string; tempDir: string }> {
    // Create temporary directory
    const tempDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
    
    // Generate unique worktree name
    const worktreeName = `${prefix}-${randomBytes(4).toString('hex')}`;
    const worktreePath = join(tempDir, worktreeName);

    try {
      // Get current branch
      const branchResult = await gitExec.exec('branch', ['--show-current'], { cwd: repositoryPath });
      const currentBranch = branchResult.stdout.trim() || 'HEAD';

      // Create worktree
      await gitExec.exec('worktree', ['add', worktreePath, currentBranch], { cwd: repositoryPath });

      return { path: worktreePath, tempDir };

    } catch (error) {
      // Clean up on failure
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Execute the plan in the temporary worktree
   */
  private async executePlan(
    plan: GitPlanStep[],
    worktreePath: string,
    failFast: boolean
  ): Promise<DryRunTranscript[]> {
    const transcript: DryRunTranscript[] = [];
    const stepResults: Record<number, boolean> = {};

    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      const stepStartTime = Date.now();

      // Check dependencies
      if (step.dependencies) {
        const dependenciesMet = step.dependencies.every(dep => stepResults[dep] === true);
        if (!dependenciesMet) {
          transcript.push({
            step: i,
            operation: step,
            status: 'skipped',
            output: 'Dependencies not met',
            duration: 0,
            timestamp: new Date().toISOString(),
            warnings: ['One or more dependencies failed']
          });
          stepResults[i] = false;
          continue;
        }
      }

      try {
        const stepResult = await this.executeStep(step, worktreePath, i);
        transcript.push(stepResult);
        stepResults[i] = stepResult.status === 'success';

        // Stop on failure if fail_fast is enabled
        if (failFast && stepResult.status === 'failure' && !step.optional) {
          break;
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        transcript.push({
          step: i,
          operation: step,
          status: 'failure',
          output: errorMessage,
          duration: Date.now() - stepStartTime,
          timestamp: new Date().toISOString(),
          errors: [errorMessage]
        });
        stepResults[i] = false;

        if (failFast && !step.optional) {
          break;
        }
      }
    }

    return transcript;
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: GitPlanStep,
    worktreePath: string,
    stepIndex: number
  ): Promise<DryRunTranscript> {
    const stepStartTime = Date.now();
    const execOptions = { cwd: worktreePath };
    let output = '';
    let changes: DryRunChanges | undefined;
    let warnings: string[] = [];
    let errors: string[] = [];

    try {
      // Capture initial state for change detection
      const initialState = await this.captureState(worktreePath);

      // Execute the operation
      switch (step.operation) {
        case 'stage':
          output = await this.executeStage(step.args, execOptions);
          break;
        case 'commit':
          output = await this.executeCommit(step.args, execOptions);
          break;
        case 'branch':
          output = await this.executeBranch(step.args, execOptions);
          break;
        case 'merge':
          output = await this.executeMerge(step.args, execOptions);
          break;
        case 'push':
          // Push operations are simulated in dry-run
          output = await this.simulatePush(step.args, execOptions);
          warnings.push('Push operation simulated - no actual push performed');
          break;
        case 'pull':
          output = await this.executePull(step.args, execOptions);
          break;
        case 'rebase':
          output = await this.executeRebase(step.args, execOptions);
          break;
        case 'stash':
          output = await this.executeStash(step.args, execOptions);
          break;
        case 'reset':
          output = await this.executeReset(step.args, execOptions);
          break;
        default:
          throw new Error(`Unsupported operation: ${step.operation}`);
      }

      // Capture changes
      const finalState = await this.captureState(worktreePath);
      changes = this.detectChanges(initialState, finalState);

      return {
        step: stepIndex,
        operation: step,
        status: warnings.length > 0 ? 'warning' : 'success',
        output,
        changes,
        duration: Date.now() - stepStartTime,
        timestamp: new Date().toISOString(),
        warnings: warnings.length > 0 ? warnings : undefined,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        step: stepIndex,
        operation: step,
        status: 'failure',
        output: errorMessage,
        duration: Date.now() - stepStartTime,
        timestamp: new Date().toISOString(),
        errors: [errorMessage]
      };
    }
  }

  /**
   * Execute stage operation
   */
  private async executeStage(args: any, execOptions: any): Promise<string> {
    const stageArgs = ['add'];
    
    if (args.paths) {
      stageArgs.push(...args.paths);
    } else if (args.patch) {
      stageArgs.push('--patch');
    } else if (args.all) {
      stageArgs.push('--all');
    } else {
      stageArgs.push('.');
    }

    await gitExec.exec('add', stageArgs.slice(1), execOptions);
    return `Staged files: ${stageArgs.slice(1).join(', ')}`;
  }

  /**
   * Execute commit operation
   */
  private async executeCommit(args: any, execOptions: any): Promise<string> {
    const commitArgs = ['--message', args.message];
    
    if (args.sign) commitArgs.push('--gpg-sign');
    if (args.amend) commitArgs.push('--amend');
    if (args.no_verify) commitArgs.push('--no-verify');

    await gitExec.exec('commit', commitArgs.slice(1), execOptions);
    return `Committed: ${args.message}`;
  }

  /**
   * Execute branch operation
   */
  private async executeBranch(args: any, execOptions: any): Promise<string> {
    switch (args.op) {
      case 'create':
        await gitExec.exec('branch', [args.name, args.from || 'HEAD'], execOptions);
        return `Created branch: ${args.name}`;
      case 'switch':
        await gitExec.exec('switch', [args.name], execOptions);
        return `Switched to branch: ${args.name}`;
      case 'delete':
        await gitExec.exec('branch', ['-d', args.name], execOptions);
        return `Deleted branch: ${args.name}`;
      default:
        throw new Error(`Unknown branch operation: ${args.op}`);
    }
  }

  /**
   * Execute merge operation
   */
  private async executeMerge(args: any, execOptions: any): Promise<string> {
    const mergeArgs = [args.target];
    
    if (args.strategy) mergeArgs.push('--strategy', args.strategy);
    if (args.no_ff) mergeArgs.push('--no-ff');

    await gitExec.exec('merge', mergeArgs, execOptions);
    return `Merged: ${args.target}`;
  }

  /**
   * Simulate push operation (dry-run safe)
   */
  private async simulatePush(args: any, execOptions: any): Promise<string> {
    // Use git push --dry-run to simulate
    const pushArgs = ['--dry-run'];
    
    if (args.remote) pushArgs.push(args.remote);
    if (args.branch) pushArgs.push(args.branch);
    if (args.force) pushArgs.push('--force');

    const result = await gitExec.exec('push', pushArgs, execOptions);
    return `Simulated push: ${result.stdout || 'No changes to push'}`;
  }

  /**
   * Execute pull operation
   */
  private async executePull(args: any, execOptions: any): Promise<string> {
    const pullArgs: string[] = [];
    
    if (args.rebase) pullArgs.push('--rebase');
    if (args.remote) pullArgs.push(args.remote);
    if (args.branch) pullArgs.push(args.branch);

    await gitExec.exec('pull', pullArgs, execOptions);
    return `Pulled changes from ${args.remote || 'origin'}`;
  }

  /**
   * Execute rebase operation
   */
  private async executeRebase(args: any, execOptions: any): Promise<string> {
    const rebaseArgs = [args.target || 'HEAD~1'];
    
    if (args.interactive) rebaseArgs.push('--interactive');
    if (args.continue) rebaseArgs.push('--continue');
    if (args.abort) rebaseArgs.push('--abort');

    await gitExec.exec('rebase', rebaseArgs, execOptions);
    return `Rebased onto: ${args.target}`;
  }

  /**
   * Execute stash operation
   */
  private async executeStash(args: any, execOptions: any): Promise<string> {
    const stashArgs = [args.op || 'push'];
    
    if (args.message) stashArgs.push('--message', args.message);
    if (args.include_untracked) stashArgs.push('--include-untracked');

    await gitExec.exec('stash', stashArgs, execOptions);
    return `Stash operation: ${args.op || 'push'}`;
  }

  /**
   * Execute reset operation
   */
  private async executeReset(args: any, execOptions: any): Promise<string> {
    const resetArgs = [args.mode || '--mixed'];
    
    if (args.target) resetArgs.push(args.target);

    await gitExec.exec('reset', resetArgs, execOptions);
    return `Reset to: ${args.target || 'HEAD'} (${args.mode || 'mixed'})`;
  }

  /**
   * Capture repository state
   */
  private async captureState(worktreePath: string): Promise<any> {
    const execOptions = { cwd: worktreePath };
    
    try {
      const [statusResult, branchResult, logResult] = await Promise.all([
        gitExec.exec('status', ['--porcelain'], execOptions),
        gitExec.exec('branch', ['--show-current'], execOptions),
        gitExec.exec('log', ['--oneline', '-5'], execOptions).catch(() => ({ stdout: '' }))
      ]);

      return {
        files: statusResult.stdout.split('\n').filter(line => line.trim()),
        branch: branchResult.stdout.trim(),
        commits: logResult.stdout.split('\n').filter(line => line.trim())
      };
    } catch (error) {
      return {
        files: [],
        branch: '',
        commits: []
      };
    }
  }

  /**
   * Detect changes between states
   */
  private detectChanges(initial: any, final: any): DryRunChanges {
    const initialFiles = new Set(initial.files);
    const finalFiles = new Set(final.files);

    const changes: DryRunChanges = {
      filesAdded: [],
      filesModified: [],
      filesDeleted: [],
      branchesCreated: [],
      branchesDeleted: [],
      commits: []
    };

    // Detect file changes
    for (const file of finalFiles) {
      if (!initialFiles.has(file)) {
        changes.filesAdded.push(String(file));
      }
    }

    for (const file of initialFiles) {
      if (!finalFiles.has(file)) {
        changes.filesDeleted.push(String(file));
      }
    }

    // Detect new commits
    const newCommits = final.commits.filter((commit: string) => 
      !initial.commits.includes(commit)
    );

    changes.commits = newCommits.map((commit: string) => ({
      sha: commit.split(' ')[0],
      message: commit.substring(commit.indexOf(' ') + 1),
      author: 'unknown',
      timestamp: new Date().toISOString(),
      changes: {
        insertions: 0,
        deletions: 0,
        files: 0
      }
    }));

    return changes;
  }

  /**
   * Generate execution summary
   */
  private generateSummary(transcript: DryRunTranscript[], totalDuration: number): DryRunSummary {
    const successfulSteps = transcript.filter(t => t.status === 'success').length;
    const failedSteps = transcript.filter(t => t.status === 'failure').length;
    const warningSteps = transcript.filter(t => t.status === 'warning').length;
    const skippedSteps = transcript.filter(t => t.status === 'skipped').length;

    // Calculate risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (failedSteps > 0 || warningSteps > 2) {
      riskLevel = 'high';
    } else if (warningSteps > 0 || skippedSteps > 0) {
      riskLevel = 'medium';
    }

    // Generate recommendations
    const recommendedActions: string[] = [];
    if (failedSteps > 0) {
      recommendedActions.push('Review and fix failed operations before executing');
    }
    if (warningSteps > 0) {
      recommendedActions.push('Address warnings to ensure smooth execution');
    }
    if (skippedSteps > 0) {
      recommendedActions.push('Check dependency requirements for skipped steps');
    }
    if (riskLevel === 'low') {
      recommendedActions.push('Plan appears safe to execute');
    }

    return {
      totalSteps: transcript.length,
      successfulSteps,
      failedSteps,
      warningSteps,
      skippedSteps,
      estimatedDuration: totalDuration,
      riskLevel,
      recommendedActions
    };
  }

  /**
   * Generate rollback instructions
   */
  private generateRollbackInstructions(transcript: DryRunTranscript[]): string[] {
    const instructions: string[] = [];
    
    // Generate rollback steps in reverse order
    for (let i = transcript.length - 1; i >= 0; i--) {
      const step = transcript[i];
      if (step.status === 'success' && step.changes) {
        switch (step.operation.operation) {
          case 'commit':
            instructions.push(`git reset HEAD~1  # Undo commit from step ${i}`);
            break;
          case 'branch':
            if (step.operation.args?.op === 'create') {
              instructions.push(`git branch -d ${step.operation.args?.name}  # Delete created branch`);
            }
            break;
          case 'merge':
            instructions.push(`git reset --hard HEAD~1  # Undo merge from step ${i}`);
            break;
          case 'stage':
            instructions.push(`git reset HEAD  # Unstage files from step ${i}`);
            break;
        }
      }
    }

    return instructions;
  }

  /**
   * Generate human-readable result summary
   */
  private generateResultSummary(summary: DryRunSummary): string {
    const parts: string[] = [];
    
    parts.push(`Plan executed: ${summary.successfulSteps}/${summary.totalSteps} steps successful`);
    
    if (summary.failedSteps > 0) {
      parts.push(`${summary.failedSteps} failed`);
    }
    
    if (summary.warningSteps > 0) {
      parts.push(`${summary.warningSteps} warnings`);
    }
    
    if (summary.skippedSteps > 0) {
      parts.push(`${summary.skippedSteps} skipped`);
    }
    
    parts.push(`Risk: ${summary.riskLevel}`);
    
    return parts.join(', ');
  }

  /**
   * Clean up temporary worktree
   */
  private async cleanupWorktree(worktreePath: string, tempDir: string): Promise<void> {
    try {
      // Remove the worktree from Git's tracking
      await gitExec.exec('worktree', ['remove', '--force', worktreePath], {});
    } catch (error) {
      // Continue with file system cleanup even if Git cleanup fails
    }

    // Remove temporary directory
    await rm(tempDir, { recursive: true, force: true });
  }
}
