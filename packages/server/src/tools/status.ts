/**
 * Git Status Tool
 * 
 * Provides detailed Git status information including staged, unstaged,
 * and untracked files with human-readable summaries.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitStatus } from '../git/index.js';
import type { GitStatus } from '../types.js';

export interface StatusArgs {
  /** Include untracked files in the output */
  include_untracked?: boolean;
  /** Show only a summary of changes */
  summary_only?: boolean;
  /** Include file paths in the output */
  include_paths?: boolean;
}

export class StatusTool extends BaseTool {
  constructor() {
    super('status');
  }

  getDescription(): string {
    return 'Get Git status showing staged, unstaged, and untracked files';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        include_untracked: {
          type: 'boolean',
          description: 'Include untracked files in the output',
          default: true
        },
        summary_only: {
          type: 'boolean',
          description: 'Show only a summary of changes without file details',
          default: false
        },
        include_paths: {
          type: 'boolean',
          description: 'Include full file paths in the output',
          default: true
        }
      }
    };
  }

  async execute(args: StatusArgs = {}, context?: ToolContext): Promise<ToolResult<GitStatus>> {
    const {
      include_untracked = true,
      summary_only = false,
      include_paths = true
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

      // Prepare Git status command arguments
      const statusArgs = ['--porcelain=v1'];
      if (include_untracked) {
        statusArgs.push('-u');
      }

      // Execute git status
      const statusResult = await gitExec.exec('status', statusArgs, execOptions);
      
      // Parse the status output
      const status = parseGitStatus(statusResult.stdout);

      // Filter out file paths if not requested
      let processedStatus = status;
      if (!include_paths) {
        processedStatus = {
          staged: status.staged.map(file => ({ ...file, path: '***' })),
          unstaged: status.unstaged.map(file => ({ ...file, path: '***' })),
          untracked: status.untracked.map(() => '***')
        };
      }

      // Create summary version if requested
      if (summary_only) {
        processedStatus = {
          staged: [],
          unstaged: [],
          untracked: []
        };
      }

      // Collect metadata
      const metadata: Record<string, any> = {
        repositoryPath,
        totalChanges: status.staged.length + status.unstaged.length + status.untracked.length,
        stagedCount: status.staged.length,
        unstagedCount: status.unstaged.length,
        untrackedCount: status.untracked.length,
        isClean: status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0,
        hasStaged: status.staged.length > 0,
        hasUnstaged: status.unstaged.length > 0,
        hasUntracked: status.untracked.length > 0
      };

      // Add file type breakdowns
      if (status.staged.length > 0) {
        const stagedByType = this.groupFilesByStatus(status.staged);
        metadata.stagedByType = stagedByType;
      }

      if (status.unstaged.length > 0) {
        const unstagedByType = this.groupFilesByStatus(status.unstaged);
        metadata.unstagedByType = unstagedByType;
      }

      // Generate human-readable summary
      const summary = this.generateSummary(status, metadata);

      return createSuccessResult(processedStatus, summary, metadata);

    } catch (error) {
      const errorMessage = error instanceof GitError 
        ? `Git error: ${error.message}` 
        : error instanceof Error 
        ? error.message 
        : 'Unknown error occurred';

      return createErrorResult(errorMessage);
    }
  }

  private groupFilesByStatus(files: { status: string }[]): Record<string, number> {
    const groups: Record<string, number> = {};
    
    for (const file of files) {
      groups[file.status] = (groups[file.status] || 0) + 1;
    }
    
    return groups;
  }

  private generateSummary(status: GitStatus, metadata: Record<string, any>): string {
    if (metadata.isClean) {
      return 'Working tree clean';
    }

    const parts: string[] = [];
    
    // Staged changes
    if (status.staged.length > 0) {
      const stagedTypes = Object.entries(metadata.stagedByType || {});
      if (stagedTypes.length === 1) {
        const [type, count] = stagedTypes[0];
        parts.push(`${count} ${type} file${count !== 1 ? 's' : ''} staged`);
      } else {
        parts.push(`${status.staged.length} staged file${status.staged.length !== 1 ? 's' : ''}`);
      }
    }

    // Unstaged changes  
    if (status.unstaged.length > 0) {
      const unstagedTypes = Object.entries(metadata.unstagedByType || {});
      if (unstagedTypes.length === 1) {
        const [type, count] = unstagedTypes[0];
        parts.push(`${count} ${type} file${count !== 1 ? 's' : ''} modified`);
      } else {
        parts.push(`${status.unstaged.length} unstaged file${status.unstaged.length !== 1 ? 's' : ''}`);
      }
    }

    // Untracked files
    if (status.untracked.length > 0) {
      parts.push(`${status.untracked.length} untracked file${status.untracked.length !== 1 ? 's' : ''}`);
    }

    return parts.join(', ');
  }
}
