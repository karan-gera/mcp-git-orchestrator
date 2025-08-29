/**
 * Branch Tool
 * 
 * Manages Git branch operations (create, switch, delete) with 
 * policy-compliant naming and safety validation.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitBranches } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { BranchResult, BranchOptions } from '../types.js';

export interface BranchArgs extends BranchOptions {
  /** Dry run mode - show what would happen without doing it */
  dry_run?: boolean;
  /** Force operation (for delete) */
  force?: boolean;
}

export class BranchTool extends BaseTool {
  constructor() {
    super('branch');
  }

  getDescription(): string {
    return 'Manage Git branches (create, switch, delete) with policy-compliant naming';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create', 'switch', 'delete', 'list'],
          description: 'Branch operation to perform'
        },
        name: {
          type: 'string',
          description: 'Branch name (required for create, switch, delete)'
        },
        from: {
          type: 'string',
          description: 'Starting point for new branch (commit, branch, or tag)'
        },
        track: {
          type: 'boolean',
          description: 'Set up tracking for new branch',
          default: false
        },
        dry_run: {
          type: 'boolean',
          description: 'Show what would happen without doing it',
          default: false
        },
        force: {
          type: 'boolean',
          description: 'Force operation (for delete)',
          default: false
        }
      },
      required: ['operation']
    };
  }

  async execute(args: BranchArgs, context?: ToolContext): Promise<ToolResult<BranchResult>> {
    const {
      operation,
      name,
      from,
      track = false,
      dry_run = false,
      force = false
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

      // Validate operation-specific requirements
      if (operation !== 'list' && !name) {
        return createErrorResult(
          `Branch name is required for ${operation} operation`,
          undefined,
          { operation }
        );
      }

      // Get current branch and all branches
      const currentBranch = await this.getCurrentBranch(execOptions);
      const allBranches = await this.getAllBranches(execOptions);

      // Execute operation
      let result: BranchResult;
      
      switch (operation) {
        case 'create':
          result = await this.handleCreate(name!, from, track, policy, allBranches, execOptions, dry_run);
          break;
        case 'switch':
          result = await this.handleSwitch(name!, currentBranch, allBranches, execOptions, dry_run);
          break;
        case 'delete':
          result = await this.handleDelete(name!, currentBranch, policy, allBranches, force, execOptions, dry_run);
          break;
        case 'list':
          result = await this.handleList(allBranches, currentBranch);
          break;
        default:
          return createErrorResult(
            `Unknown operation: ${operation}`,
            undefined,
            { operation, validOperations: ['create', 'switch', 'delete', 'list'] }
          );
      }

      const metadata = {
        repositoryPath,
        operation,
        currentBranch,
        allBranches: allBranches.map(b => ({ name: b.name, current: b.current })),
        dryRun: dry_run
      };

      const summary = this.generateSummary(result, operation, dry_run);

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
   * Get all branches
   */
  private async getAllBranches(execOptions: any) {
    const result = await gitExec.exec('branch', ['-a', '--format=%(refname:short)|%(HEAD)|%(upstream:short)'], execOptions);
    return parseGitBranches(result.stdout);
  }

  /**
   * Handle create operation
   */
  private async handleCreate(
    name: string,
    from: string | undefined,
    track: boolean,
    policy: any,
    allBranches: any[],
    execOptions: any,
    dryRun: boolean
  ): Promise<BranchResult> {
    // Validate branch name against policy
    const nameValidation = policyLoader.validateBranchName(policy, name);
    if (!nameValidation.valid) {
      throw new Error(`Branch name validation failed: ${nameValidation.errors.join(', ')}`);
    }

    // Check if branch already exists
    const existingBranch = allBranches.find(b => b.name === name);
    if (existingBranch) {
      throw new Error(`Branch '${name}' already exists`);
    }

    // Validate starting point if provided
    if (from) {
      try {
        await gitExec.exec('rev-parse', ['--verify', from], execOptions);
      } catch {
        throw new Error(`Invalid starting point: ${from}`);
      }
    }

    if (dryRun) {
      return {
        operation: 'create',
        branch: name,
        success: true,
        current: false,
        from: from || 'HEAD',
        tracking: track
      };
    }

    // Create safety snapshot
    if (policy.safety_snapshots.auto_create && 
        policy.safety_snapshots.trigger_operations.includes('branch')) {
      await gitExec.createSafetySnapshot('stash', 'Before branch creation');
    }

    // Build create command arguments
    const args = ['branch'];
    if (track) {
      args.push('--track');
    }
    args.push(name);
    if (from) {
      args.push(from);
    }

    await gitExec.exec('branch', args.slice(1), execOptions);

    return {
      operation: 'create',
      branch: name,
      success: true,
      current: false,
      from: from || 'HEAD',
      tracking: track
    };
  }

  /**
   * Handle switch operation
   */
  private async handleSwitch(
    name: string,
    currentBranch: string,
    allBranches: any[],
    execOptions: any,
    dryRun: boolean
  ): Promise<BranchResult> {
    // Check if already on target branch
    if (currentBranch === name) {
      return {
        operation: 'switch',
        branch: name,
        success: true,
        current: true,
        from: currentBranch,
        message: 'Already on target branch'
      };
    }

    // Check if target branch exists
    const targetBranch = allBranches.find(b => b.name === name || b.name === `origin/${name}`);
    if (!targetBranch) {
      throw new Error(`Branch '${name}' does not exist`);
    }

    // Check for uncommitted changes
    const statusResult = await gitExec.exec('status', ['--porcelain'], execOptions);
    if (statusResult.stdout.trim()) {
      throw new Error('Cannot switch branches with uncommitted changes. Commit or stash changes first.');
    }

    if (dryRun) {
      return {
        operation: 'switch',
        branch: name,
        success: true,
        current: false,
        from: currentBranch
      };
    }

    // Switch to branch
    if (targetBranch.name.startsWith('origin/') && !allBranches.find(b => b.name === name)) {
      // Create local tracking branch for remote branch
      await gitExec.exec('switch', ['-c', name, '--track', targetBranch.name], execOptions);
    } else {
      // Switch to existing local branch
      await gitExec.exec('switch', [name], execOptions);
    }

    return {
      operation: 'switch',
      branch: name,
      success: true,
      current: true,
      from: currentBranch
    };
  }

  /**
   * Handle delete operation
   */
  private async handleDelete(
    name: string,
    currentBranch: string,
    policy: any,
    allBranches: any[],
    force: boolean,
    execOptions: any,
    dryRun: boolean
  ): Promise<BranchResult> {
    // Check if trying to delete current branch
    if (currentBranch === name) {
      throw new Error('Cannot delete the current branch. Switch to another branch first.');
    }

    // Check if branch exists
    const targetBranch = allBranches.find(b => b.name === name);
    if (!targetBranch) {
      throw new Error(`Branch '${name}' does not exist`);
    }

    // Check if trying to delete protected branch
    const isProtected = policyLoader.isBranchProtected(policy, name);
    if (isProtected) {
      throw new Error(`Cannot delete protected branch '${name}'`);
    }

    // Check if branch is merged (unless force)
    if (!force) {
      try {
        await gitExec.exec('branch', ['--merged'], execOptions);
        const mergedResult = await gitExec.exec('branch', ['--merged'], execOptions);
        const mergedBranches = mergedResult.stdout.split('\n')
          .map(line => line.trim().replace(/^\*\s*/, ''))
          .filter(line => line && line !== 'main' && line !== 'master');
        
        if (!mergedBranches.includes(name)) {
          throw new Error(`Branch '${name}' is not fully merged. Use force=true to delete anyway.`);
        }
      } catch (error) {
        // If we can't check merge status, proceed with caution
      }
    }

    if (dryRun) {
      return {
        operation: 'delete',
        branch: name,
        success: true,
        current: false,
        forced: force
      };
    }

    // Delete branch
    const deleteFlag = force ? '-D' : '-d';
    await gitExec.exec('branch', [deleteFlag, name], execOptions);

    return {
      operation: 'delete',
      branch: name,
      success: true,
      current: false,
      forced: force
    };
  }

  /**
   * Handle list operation
   */
  private async handleList(allBranches: any[], currentBranch: string): Promise<BranchResult> {
    return {
      operation: 'list',
      success: true,
      branches: allBranches.map(branch => ({
        name: branch.name,
        current: branch.current || branch.name === currentBranch,
        remote: branch.name.startsWith('origin/'),
        upstream: branch.upstream,
        sha: branch.sha || 'unknown'
      }))
    };
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: BranchResult, operation: string, dryRun: boolean): string {
    const prefix = dryRun ? 'Would ' : '';
    
    switch (operation) {
      case 'create':
        const trackingInfo = result.tracking ? ' with tracking' : '';
        const fromInfo = result.from && result.from !== 'HEAD' ? ` from ${result.from}` : '';
        return `${prefix}create branch '${result.branch}'${fromInfo}${trackingInfo}`;
      
      case 'switch':
        if (result.message) {
          return result.message;
        }
        return `${prefix}switch to branch '${result.branch}' from '${result.from}'`;
      
      case 'delete':
        const forceInfo = result.forced ? ' (forced)' : '';
        return `${prefix}delete branch '${result.branch}'${forceInfo}`;
      
      case 'list':
        const count = result.branches?.length || 0;
        const currentBranch = result.branches?.find(b => b.current)?.name || 'unknown';
        return `Found ${count} branches, current: ${currentBranch}`;
      
      default:
        return `${prefix}${operation} operation completed`;
    }
  }
}
