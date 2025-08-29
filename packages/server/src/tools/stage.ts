/**
 * Stage Tool
 * 
 * Provides selective staging of files and hunks with safety validation
 * and policy integration.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitStatus, parseGitDiff } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { StageResult, StageOptions, HunkSelector } from '../types.js';

export interface StageArgs extends StageOptions {
  /** Dry run mode - show what would be staged without doing it */
  dry_run?: boolean;
  /** Interactive mode for hunk selection */
  interactive?: boolean;
}

export class StageTool extends BaseTool {
  constructor() {
    super('stage');
  }

  getDescription(): string {
    return 'Stage files and hunks selectively with policy validation';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific file paths to stage'
        },
        hunks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'File path' },
              hunkIndex: { type: 'number', description: 'Hunk index (0-based)' },
              lines: { 
                type: 'array',
                items: { type: 'number' },
                description: 'Specific lines within the hunk (optional)'
              }
            },
            required: ['file', 'hunkIndex']
          },
          description: 'Specific hunks to stage'
        },
        patch: {
          type: 'boolean',
          description: 'Use patch mode for interactive staging',
          default: false
        },
        dry_run: {
          type: 'boolean',
          description: 'Show what would be staged without doing it',
          default: false
        },
        interactive: {
          type: 'boolean', 
          description: 'Interactive mode for hunk selection',
          default: false
        }
      }
    };
  }

  async execute(args: StageArgs = {}, context?: ToolContext): Promise<ToolResult<StageResult>> {
    const {
      paths,
      hunks,
      patch = false,
      dry_run = false,
      interactive = false
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

      // Validate staging operation
      const validation = await this.validateStaging(paths, hunks, policy, repositoryPath);
      if (!validation.valid) {
        return createErrorResult(
          validation.errors.join(', '),
          undefined,
          { validationErrors: validation.errors }
        );
      }

      // Get current status before staging
      const beforeStatus = await this.getStatus(execOptions);

      let stagedFiles: string[] = [];
      let stagedCount = 0;

      if (dry_run) {
        // Dry run mode - just calculate what would be staged
        const result = await this.calculateStagingChanges(paths, hunks, execOptions);
        return createSuccessResult(
          { stagedCount: result.length, files: result },
          `Would stage ${result.length} ${this.pluralize('file', result.length)} (dry run)`,
          { 
            repositoryPath, 
            dryRun: true, 
            wouldStage: result,
            beforeStatus
          }
        );
      }

      // Create safety snapshot before staging
      if (policy.safety_snapshots.auto_create && 
          policy.safety_snapshots.trigger_operations.includes('stage')) {
        await gitExec.createSafetySnapshot('stash', 'Before staging operation');
      }

      // Execute staging operations
      if (interactive || patch) {
        // Interactive/patch mode
        const result = await this.stageInteractive(paths, patch, execOptions);
        stagedFiles = result.files;
        stagedCount = result.count;
      } else if (hunks && hunks.length > 0) {
        // Hunk-specific staging
        const result = await this.stageHunks(hunks, execOptions);
        stagedFiles = result.files;
        stagedCount = result.count;
      } else if (paths && paths.length > 0) {
        // Path-specific staging
        const result = await this.stagePaths(paths, execOptions);
        stagedFiles = result.files;
        stagedCount = result.count;
      } else {
        // Stage all unstaged files
        const result = await this.stageAll(execOptions);
        stagedFiles = result.files;
        stagedCount = result.count;
      }

      // Get status after staging
      const afterStatus = await this.getStatus(execOptions);

      const stageResult: StageResult = {
        stagedCount,
        files: stagedFiles
      };

      const metadata = {
        repositoryPath,
        operation: this.getOperationType(args),
        beforeStatus,
        afterStatus,
        policy: {
          autoSnapshot: policy.safety_snapshots.auto_create,
          validation: validation.warnings
        }
      };

      const summary = this.generateSummary(stageResult, metadata);

      return createSuccessResult(stageResult, summary, metadata);

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
   * Validate staging operation against policy
   */
  private async validateStaging(
    paths: string[] | undefined,
    hunks: HunkSelector[] | undefined, 
    policy: any,
    repositoryPath: string
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if files exist and are in the repository
    if (paths) {
      for (const path of paths) {
        try {
          // Check if file is tracked or in working directory
          await gitExec.exec('ls-files', ['--error-unmatch', path], { cwd: repositoryPath });
        } catch {
          // Check if it's an untracked file in working directory
          try {
            await gitExec.exec('ls-files', ['--others', '--exclude-standard', path], { cwd: repositoryPath });
          } catch {
            errors.push(`File not found in repository: ${path}`);
          }
        }
      }
    }

    // Validate hunk selectors
    if (hunks) {
      for (const hunk of hunks) {
        if (hunk.hunkIndex < 0) {
          errors.push(`Invalid hunk index: ${hunk.hunkIndex}`);
        }
        if (hunk.lines && hunk.lines.some(line => line < 0)) {
          errors.push(`Invalid line numbers in hunk for ${hunk.file}`);
        }
      }
    }

    // Policy-specific validations
    if (policy.repository.respect_hooks) {
      warnings.push('Repository has hooks enabled - they will be respected during staging');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Get current Git status
   */
  private async getStatus(execOptions: any) {
    const statusResult = await gitExec.exec('status', ['--porcelain=v1'], execOptions);
    return parseGitStatus(statusResult.stdout);
  }

  /**
   * Calculate what would be staged without actually staging
   */
  private async calculateStagingChanges(
    paths: string[] | undefined,
    hunks: HunkSelector[] | undefined,
    execOptions: any
  ): Promise<string[]> {
    if (hunks && hunks.length > 0) {
      return [...new Set(hunks.map(h => h.file))];
    }
    
    if (paths && paths.length > 0) {
      return paths;
    }

    // All unstaged files
    const status = await this.getStatus(execOptions);
    return [...status.unstaged.map(f => f.path), ...status.untracked];
  }

  /**
   * Stage files interactively or with patch mode
   */
  private async stageInteractive(
    paths: string[] | undefined,
    patch: boolean,
    execOptions: any
  ): Promise<{ files: string[]; count: number }> {
    const args = ['add'];
    
    if (patch) {
      args.push('--patch');
    } else {
      args.push('--interactive');
    }

    if (paths && paths.length > 0) {
      args.push(...paths);
    } else {
      args.push('.');
    }

    await gitExec.exec('add', args.slice(1), execOptions);

    // Get staged files after operation
    const status = await this.getStatus(execOptions);
    const stagedFiles = status.staged.map(f => f.path);

    return {
      files: stagedFiles,
      count: stagedFiles.length
    };
  }

  /**
   * Stage specific hunks
   */
  private async stageHunks(
    hunks: HunkSelector[],
    execOptions: any
  ): Promise<{ files: string[]; count: number }> {
    const stagedFiles = new Set<string>();

    // Group hunks by file for efficiency
    const hunksByFile = new Map<string, HunkSelector[]>();
    for (const hunk of hunks) {
      if (!hunksByFile.has(hunk.file)) {
        hunksByFile.set(hunk.file, []);
      }
      hunksByFile.get(hunk.file)!.push(hunk);
    }

    for (const [file, fileHunks] of hunksByFile) {
      // Get diff for the file
      const diffResult = await gitExec.exec('diff', [file], execOptions);
      const diff = parseGitDiff(diffResult.stdout);
      
      if (diff.hunks.length === 0) {
        continue; // No changes in this file
      }

      // Create patch for selected hunks
      const patchLines: string[] = [];
      for (const hunk of fileHunks) {
        if (hunk.hunkIndex < diff.hunks.length) {
          const diffHunk = diff.hunks[hunk.hunkIndex];
          patchLines.push(diffHunk.header);
          
          if (hunk.lines && hunk.lines.length > 0) {
            // Stage specific lines within the hunk
            for (const lineIndex of hunk.lines) {
              if (lineIndex < diffHunk.lines.length) {
                const line = diffHunk.lines[lineIndex];
                patchLines.push(line.type === 'addition' ? `+${line.content}` : 
                               line.type === 'deletion' ? `-${line.content}` : 
                               ` ${line.content}`);
              }
            }
          } else {
            // Stage entire hunk
            for (const line of diffHunk.lines) {
              patchLines.push(line.type === 'addition' ? `+${line.content}` : 
                             line.type === 'deletion' ? `-${line.content}` : 
                             ` ${line.content}`);
            }
          }
        }
      }

      if (patchLines.length > 0) {
        // Apply patch
        const patch = patchLines.join('\n');
        await gitExec.exec('apply', ['--cached'], { ...execOptions, input: patch });
        stagedFiles.add(file);
      }
    }

    return {
      files: Array.from(stagedFiles),
      count: stagedFiles.size
    };
  }

  /**
   * Stage specific paths
   */
  private async stagePaths(
    paths: string[],
    execOptions: any
  ): Promise<{ files: string[]; count: number }> {
    await gitExec.exec('add', paths, execOptions);

    return {
      files: paths,
      count: paths.length
    };
  }

  /**
   * Stage all unstaged files
   */
  private async stageAll(execOptions: any): Promise<{ files: string[]; count: number }> {
    const status = await this.getStatus(execOptions);
    const allFiles = [...status.unstaged.map(f => f.path), ...status.untracked];

    if (allFiles.length === 0) {
      return { files: [], count: 0 };
    }

    await gitExec.exec('add', ['.'], execOptions);

    return {
      files: allFiles,
      count: allFiles.length
    };
  }

  /**
   * Get operation type for metadata
   */
  private getOperationType(args: StageArgs): string {
    if (args.hunks && args.hunks.length > 0) return 'hunks';
    if (args.paths && args.paths.length > 0) return 'paths';
    if (args.interactive) return 'interactive';
    if (args.patch) return 'patch';
    return 'all';
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: StageResult, metadata: any): string {
    const { stagedCount } = result;
    const operation = metadata.operation;

    if (stagedCount === 0) {
      return 'No files staged';
    }

    const parts: string[] = [];
    parts.push(`Staged ${stagedCount} ${this.pluralize('file', stagedCount)}`);

    if (operation !== 'all') {
      parts.push(`(${operation} mode)`);
    }

    if (metadata.policy?.autoSnapshot) {
      parts.push('with safety snapshot');
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
