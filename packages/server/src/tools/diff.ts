/**
 * Git Diff Tool
 * 
 * Provides detailed diff information for staged, unstaged, or specific files
 * with structured output and human-readable summaries.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitDiff } from '../git/index.js';
import type { DiffResult } from '../types.js';

export interface DiffArgs {
  /** Scope of the diff operation */
  scope?: 'staged' | 'unstaged' | 'path';
  /** Specific file path when scope is "path" */
  path?: string;
  /** Maximum number of context lines to show around changes */
  context_lines?: number;
  /** Include binary file information */
  include_binary?: boolean;
  /** Limit output to file names only */
  name_only?: boolean;
  /** Show statistics summary */
  stat?: boolean;
}

export class DiffTool extends BaseTool {
  constructor() {
    super('diff');
  }

  getDescription(): string {
    return 'Get diff information for staged, unstaged, or specific files';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['staged', 'unstaged', 'path'],
          description: 'Scope of the diff operation',
          default: 'unstaged'
        },
        path: {
          type: 'string',
          description: 'Specific file path when scope is "path"'
        },
        context_lines: {
          type: 'number',
          description: 'Number of context lines to show around changes',
          default: 3,
          minimum: 0,
          maximum: 20
        },
        include_binary: {
          type: 'boolean',
          description: 'Include binary file information in diff',
          default: false
        },
        name_only: {
          type: 'boolean',
          description: 'Show only file names without diff content',
          default: false
        },
        stat: {
          type: 'boolean',
          description: 'Show diffstat summary',
          default: false
        }
      },
      required: []
    };
  }

  async execute(args: DiffArgs = {}, context?: ToolContext): Promise<ToolResult<DiffResult>> {
    const {
      scope = 'unstaged',
      path,
      context_lines = 3,
      include_binary = false,
      name_only = false,
      stat = false
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

      // Validate arguments
      if (scope === 'path' && !path) {
        return createErrorResult(
          'Path is required when scope is "path"',
          undefined,
          { scope, path }
        );
      }

      // Build diff command arguments
      const diffArgs = this.buildDiffArgs(scope, path, context_lines, include_binary, name_only, stat);

      // Execute git diff
      const diffResult = await gitExec.exec('diff', diffArgs, execOptions);
      
      // Handle empty diff
      if (!diffResult.stdout.trim()) {
        const emptyResult: DiffResult = { files: [], hunks: [] };
        const summary = this.generateEmptySummary(scope, path);
        
        return createSuccessResult(emptyResult, summary, {
          repositoryPath,
          scope,
          path,
          isEmpty: true,
          hasChanges: false,
          contextLines: context_lines,
          includeBinary: include_binary,
          nameOnly: name_only,
          stat
        });
      }

      // Parse the diff output (only if not name-only or stat)
      let result: DiffResult;
      if (name_only || stat) {
        // For name-only and stat, create simplified result
        const lines = diffResult.stdout.split('\n').filter(line => line.trim());
        result = {
          files: lines.map(line => ({
            path: line,
            status: 'modified' as const,
            additions: 0,
            deletions: 0
          })),
          hunks: []
        };
      } else {
        result = parseGitDiff(diffResult.stdout);
      }

      // Collect metadata
      const metadata: Record<string, any> = {
        repositoryPath,
        scope,
        path,
        contextLines: context_lines,
        includeBinary: include_binary,
        nameOnly: name_only,
        stat,
        isEmpty: false,
        hasChanges: true,
        fileCount: result.files.length,
        hunkCount: result.hunks.length,
        totalAdditions: result.files.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: result.files.reduce((sum, file) => sum + file.deletions, 0)
      };

      // Add file type breakdown
      if (result.files.length > 0) {
        const filesByType = this.groupFilesByType(result.files);
        metadata.filesByType = filesByType;

        const statusCounts = this.groupFilesByStatus(result.files);
        metadata.statusCounts = statusCounts;
      }

      // Generate human-readable summary
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

  private buildDiffArgs(
    scope: string, 
    path: string | undefined, 
    contextLines: number, 
    includeBinary: boolean, 
    nameOnly: boolean, 
    stat: boolean
  ): string[] {
    const args: string[] = [];

    // Add context lines
    if (contextLines !== 3) {
      args.push(`--unified=${contextLines}`);
    }

    // Add binary handling
    if (!includeBinary) {
      args.push('--no-textconv');
    }

    // Add output format options
    if (nameOnly) {
      args.push('--name-only');
    } else if (stat) {
      args.push('--stat');
    }

    // Add scope-specific arguments
    switch (scope) {
      case 'staged':
        args.push('--cached');
        break;
      case 'unstaged':
        // Default behavior - no additional args needed
        break;
      case 'path':
        if (path) {
          args.push('--', path);
        }
        break;
    }

    return args;
  }

  private groupFilesByType(files: { path: string }[]): Record<string, number> {
    const groups: Record<string, number> = {};
    
    for (const file of files) {
      const extension = file.path.split('.').pop()?.toLowerCase() || 'no-ext';
      groups[extension] = (groups[extension] || 0) + 1;
    }
    
    return groups;
  }

  private groupFilesByStatus(files: { status: string }[]): Record<string, number> {
    const groups: Record<string, number> = {};
    
    for (const file of files) {
      groups[file.status] = (groups[file.status] || 0) + 1;
    }
    
    return groups;
  }

  private generateEmptySummary(scope: string, path?: string): string {
    if (scope === 'path' && path) {
      return `No changes in ${path}`;
    }
    
    switch (scope) {
      case 'staged':
        return 'No staged changes';
      case 'unstaged':
        return 'No unstaged changes';
      default:
        return 'No changes';
    }
  }

  private generateSummary(_result: DiffResult, metadata: Record<string, any>): string {
    const { fileCount, totalAdditions, totalDeletions, scope } = metadata;
    
    if (fileCount === 0) {
      return this.generateEmptySummary(scope, metadata.path);
    }

    const parts: string[] = [];
    
    // File count
    if (fileCount === 1) {
      parts.push('1 file changed');
    } else {
      parts.push(`${fileCount} files changed`);
    }

    // Additions and deletions
    const changes: string[] = [];
    if (totalAdditions > 0) {
      changes.push(`${totalAdditions} insertion${totalAdditions !== 1 ? 's' : ''}(+)`);
    }
    if (totalDeletions > 0) {
      changes.push(`${totalDeletions} deletion${totalDeletions !== 1 ? 's' : ''}(-)`);
    }
    
    if (changes.length > 0) {
      parts.push(changes.join(', '));
    }

    // Scope context
    const scopeContext = scope === 'staged' ? ' staged' : 
                        scope === 'path' ? ` in ${metadata.path}` : '';
    
    return parts.join(', ') + scopeContext;
  }
}
