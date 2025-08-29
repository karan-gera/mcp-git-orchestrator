/**
 * Repository Overview Tool
 * 
 * Provides a comprehensive overview of the current Git repository state
 * including branch information, remotes, and basic statistics.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitBranches, parseGitRemotes, parseAheadBehind } from '../git/index.js';
import type { RepoOverview } from '../types.js';

export interface RepoOverviewArgs {
  /** Include detailed branch information */
  include_branches?: boolean;
  /** Include remote information */
  include_remotes?: boolean;
  /** Include ahead/behind counts for current branch */
  include_tracking?: boolean;
}

export class RepoOverviewTool extends BaseTool {
  constructor() {
    super('repo_overview');
  }

  getDescription(): string {
    return 'Get repository overview with branch, head, and remote information';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        include_branches: {
          type: 'boolean',
          description: 'Include detailed branch information',
          default: true
        },
        include_remotes: {
          type: 'boolean', 
          description: 'Include remote repository information',
          default: true
        },
        include_tracking: {
          type: 'boolean',
          description: 'Include ahead/behind counts for current branch',
          default: true
        }
      }
    };
  }

  async execute(args: RepoOverviewArgs = {}, context?: ToolContext): Promise<ToolResult<RepoOverview>> {
    const {
      include_branches = true,
      include_remotes = true,
      include_tracking = true
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

      // Get repository root
      const rootResult = await gitExec.exec('rev-parse', ['--show-toplevel'], execOptions);
      const root = rootResult.stdout;

      // Get current branch
      let branch = 'HEAD';
      try {
        const branchResult = await gitExec.exec('symbolic-ref', ['--short', 'HEAD'], execOptions);
        branch = branchResult.stdout;
      } catch {
        // Detached HEAD state
        const headResult = await gitExec.exec('rev-parse', ['--short', 'HEAD'], execOptions);
        branch = `detached@${headResult.stdout}`;
      }

      // Get HEAD commit
      const headResult = await gitExec.exec('rev-parse', ['HEAD'], execOptions);
      const head = headResult.stdout;

      // Initialize overview data
      const overview: RepoOverview = {
        root,
        branch,
        head,
        remotes: [],
        aheadBehind: { ahead: 0, behind: 0 }
      };

      // Get remotes if requested
      if (include_remotes) {
        try {
          const remotesResult = await gitExec.exec('remote', ['-v'], execOptions);
          if (remotesResult.stdout.trim()) {
            overview.remotes = parseGitRemotes(remotesResult.stdout);
          }
        } catch (error) {
          // Ignore remote errors - repository might not have remotes
        }
      }

      // Get ahead/behind tracking if requested and not in detached HEAD
      if (include_tracking && !branch.startsWith('detached@')) {
        try {
          const statusResult = await gitExec.exec('status', ['-b', '--porcelain=v1'], execOptions);
          overview.aheadBehind = parseAheadBehind(statusResult.stdout);
        } catch (error) {
          // Ignore tracking errors - branch might not have upstream
        }
      }

      // Collect additional metadata
      const metadata: Record<string, any> = {
        repositoryPath,
        isDetachedHead: branch.startsWith('detached@'),
        hasRemotes: overview.remotes.length > 0,
        hasUpstream: overview.aheadBehind.ahead > 0 || overview.aheadBehind.behind > 0
      };

      // Add branch information if requested
      if (include_branches) {
        try {
          const branchesResult = await gitExec.exec('branch', ['-v'], execOptions);
          const branches = parseGitBranches(branchesResult.stdout);
          metadata.branches = branches;
          metadata.branchCount = branches.length;
        } catch (error) {
          // Continue without branch details
        }
      }

      // Generate human-readable summary
      const summary = this.generateSummary(overview, metadata);

      return createSuccessResult(overview, summary, metadata);

    } catch (error) {
      const errorMessage = error instanceof GitError 
        ? `Git error: ${error.message}` 
        : error instanceof Error 
        ? error.message 
        : 'Unknown error occurred';

      return createErrorResult(errorMessage);
    }
  }

  private generateSummary(overview: RepoOverview, metadata: Record<string, any>): string {
    const parts: string[] = [];

    // Basic repository info
    if (metadata.isDetachedHead) {
      parts.push(`Repository in detached HEAD state (${overview.head.slice(0, 8)})`);
    } else {
      parts.push(`Repository on branch '${overview.branch}'`);
    }

    // Tracking information
    if (overview.aheadBehind.ahead > 0 || overview.aheadBehind.behind > 0) {
      const trackingParts: string[] = [];
      if (overview.aheadBehind.ahead > 0) {
        trackingParts.push(`${overview.aheadBehind.ahead} ahead`);
      }
      if (overview.aheadBehind.behind > 0) {
        trackingParts.push(`${overview.aheadBehind.behind} behind`);
      }
      parts.push(`(${trackingParts.join(', ')})`);
    }

    // Remote information
    if (overview.remotes.length > 0) {
      const uniqueRemotes = new Set(overview.remotes.map(r => r.name));
      parts.push(`with ${uniqueRemotes.size} remote${uniqueRemotes.size !== 1 ? 's' : ''}`);
    } else {
      parts.push('(no remotes)');
    }

    // Branch count
    if (metadata.branchCount !== undefined) {
      parts.push(`${metadata.branchCount} total branch${metadata.branchCount !== 1 ? 'es' : ''}`);
    }

    return parts.join(' ');
  }
}
