/**
 * Merge Tool
 * 
 * Provides merge preflight analysis with conflict forecasting.
 * Does NOT complete merges - only analyzes potential conflicts and outcomes.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitDiff } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { MergePreflightResult, ConflictForecast, ConflictRegion } from '../types.js';

export interface MergeArgs {
  /** Target branch to merge into current branch */
  target: string;
  /** Strategy for merge analysis */
  strategy?: 'merge' | 'rebase' | 'squash';
  /** Create temporary worktree for analysis */
  use_worktree?: boolean;
  /** Include detailed diff analysis */
  detailed_analysis?: boolean;
}

export class MergeTool extends BaseTool {
  constructor() {
    super('merge');
  }

  getDescription(): string {
    return 'Analyze merge operations and forecast potential conflicts without executing merges';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Target branch to merge (required)'
        },
        strategy: {
          type: 'string',
          enum: ['merge', 'rebase', 'squash'],
          description: 'Merge strategy for analysis',
          default: 'merge'
        },
        use_worktree: {
          type: 'boolean',
          description: 'Use temporary worktree for analysis',
          default: false
        },
        detailed_analysis: {
          type: 'boolean',
          description: 'Include detailed conflict region analysis',
          default: false
        }
      },
      required: ['target']
    };
  }

  async execute(args: MergeArgs, context?: ToolContext): Promise<ToolResult<MergePreflightResult>> {
    const {
      target,
      strategy = 'merge',
      use_worktree = false,
      detailed_analysis = false
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

      // Get current branch
      const currentBranch = await this.getCurrentBranch(execOptions);
      
      // Validate target branch exists
      await this.validateTargetBranch(target, execOptions);

      // Check for uncommitted changes
      const hasUncommittedChanges = await this.hasUncommittedChanges(execOptions);
      if (hasUncommittedChanges) {
        return createErrorResult(
          'Cannot analyze merge with uncommitted changes. Commit or stash changes first.',
          undefined,
          { currentBranch, target, uncommittedChanges: true }
        );
      }

      // Check if target is protected and policy allows merges
      const isTargetProtected = policyLoader.isBranchProtected(policy, target);
      const policyViolations = this.checkMergePolicy(policy, currentBranch, target, isTargetProtected);

      // Perform conflict analysis
      const analysis = use_worktree 
        ? await this.analyzeWithWorktree(currentBranch, target, strategy, execOptions, detailed_analysis)
        : await this.analyzeWithDiffIntersection(currentBranch, target, execOptions, detailed_analysis);

      // Generate forecast based on analysis
      const forecast = this.generateConflictForecast(analysis, currentBranch, target, strategy);

      const result: MergePreflightResult = {
        currentBranch,
        targetBranch: target,
        strategy,
        canMerge: analysis.conflicts.length === 0 && policyViolations.length === 0,
        conflicts: analysis.conflicts,
        forecast,
        policyViolations,
        analysis: detailed_analysis ? analysis.detailed : undefined
      };

      const metadata = {
        repositoryPath,
        analysisMethod: use_worktree ? 'worktree' : 'diff-intersection',
        isTargetProtected,
        conflictCount: analysis.conflicts.length,
        policyViolationCount: policyViolations.length
      };

      const summary = this.generateSummary(result);

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
      throw new Error('Cannot perform merge analysis from detached HEAD');
    }
  }

  /**
   * Validate that target branch exists
   */
  private async validateTargetBranch(target: string, execOptions: any): Promise<void> {
    try {
      await gitExec.exec('rev-parse', ['--verify', target], execOptions);
    } catch {
      throw new Error(`Target branch '${target}' does not exist`);
    }
  }

  /**
   * Check for uncommitted changes
   */
  private async hasUncommittedChanges(execOptions: any): Promise<boolean> {
    const statusResult = await gitExec.exec('status', ['--porcelain'], execOptions);
    return statusResult.stdout.trim().length > 0;
  }

  /**
   * Check merge against policy
   */
  private checkMergePolicy(policy: any, currentBranch: string, target: string, isTargetProtected: boolean): string[] {
    const violations: string[] = [];

    if (isTargetProtected && policy.merge_strategy?.require_pr) {
      violations.push(`Cannot merge into protected branch '${target}' without pull request`);
    }

    if (policy.merge_strategy?.require_clean_tree) {
      // This would be checked elsewhere for uncommitted changes
    }

    if (policy.merge_strategy?.denied_patterns) {
      for (const pattern of policy.merge_strategy.denied_patterns) {
        const regex = new RegExp(pattern);
        if (regex.test(`${currentBranch}->${target}`)) {
          violations.push(`Merge pattern '${currentBranch}->${target}' is denied by policy`);
        }
      }
    }

    return violations;
  }

  /**
   * Analyze potential conflicts using diff intersection
   */
  private async analyzeWithDiffIntersection(
    currentBranch: string, 
    target: string, 
    execOptions: any,
    detailed: boolean
  ): Promise<{ conflicts: ConflictRegion[]; detailed?: any }> {
    // Get merge base
    const mergeBaseResult = await gitExec.exec('merge-base', [currentBranch, target], execOptions);
    const mergeBase = mergeBaseResult.stdout.trim();

    // Get diffs from merge base to each branch
    const currentDiffResult = await gitExec.exec('diff', [mergeBase, currentBranch], execOptions);
    const targetDiffResult = await gitExec.exec('diff', [mergeBase, target], execOptions);

    const currentDiff = parseGitDiff(currentDiffResult.stdout);
    const targetDiff = parseGitDiff(targetDiffResult.stdout);

    // Find overlapping file changes
    const conflicts: ConflictRegion[] = [];
    const currentFiles = new Map(currentDiff.files.map(f => [f.path, f]));
    const targetFiles = new Map(targetDiff.files.map(f => [f.path, f]));

    for (const [filePath, currentFile] of currentFiles) {
      const targetFile = targetFiles.get(filePath);
      if (targetFile) {
        // Both branches modified the same file - potential conflict
        const conflict = await this.analyzeFileConflict(
          filePath, 
          currentFile, 
          targetFile, 
          currentDiff, 
          targetDiff,
          detailed
        );
        if (conflict) {
          conflicts.push(conflict);
        }
      }
    }

    return {
      conflicts,
      detailed: detailed ? {
        mergeBase,
        currentBranchChanges: currentDiff.files.length,
        targetBranchChanges: targetDiff.files.length,
        overlappingFiles: conflicts.length
      } : undefined
    };
  }

  /**
   * Analyze potential conflicts using temporary worktree
   */
  private async analyzeWithWorktree(
    currentBranch: string, 
    target: string, 
    strategy: string,
    execOptions: any,
    detailed: boolean
  ): Promise<{ conflicts: ConflictRegion[]; detailed?: any }> {
    const tempDir = `/tmp/mcp-merge-analysis-${Date.now()}`;
    
    try {
      // Create temporary worktree
      await gitExec.exec('worktree', ['add', tempDir, currentBranch], execOptions);
      const tempExecOptions = { cwd: tempDir };

      // Attempt merge with --no-commit --no-ff
      try {
        const mergeArgs = ['--no-commit', '--no-ff'];
        if (strategy === 'squash') {
          mergeArgs.push('--squash');
        }
        mergeArgs.push(target);

        await gitExec.exec('merge', mergeArgs, tempExecOptions);
        
        // No conflicts - merge would succeed
        return { conflicts: [], detailed: detailed ? { mergeStrategy: 'clean' } : undefined };
        
      } catch (error) {
        // Merge failed - analyze conflicts
        const conflicts = await this.parseWorktreeConflicts(tempExecOptions, detailed);
        return { conflicts, detailed: detailed ? { mergeStrategy: 'conflicted' } : undefined };
      }

    } finally {
      // Clean up temporary worktree
      try {
        await gitExec.exec('worktree', ['remove', '--force', tempDir], execOptions);
      } catch {
        // Best effort cleanup
      }
    }
  }

  /**
   * Analyze potential conflict in a single file
   */
  private async analyzeFileConflict(
    filePath: string,
    _currentFile: any,
    _targetFile: any,
    currentDiff: any,
    targetDiff: any,
    _detailed: boolean
  ): Promise<ConflictRegion | null> {
    // Get hunks for this file from both diffs
    const currentHunks = currentDiff.hunks.filter((h: any) => h.file === filePath);
    const targetHunks = targetDiff.hunks.filter((h: any) => h.file === filePath);

    const overlappingRanges: Array<{ start: number; end: number; severity: 'low' | 'medium' | 'high' }> = [];

    // Check for overlapping line ranges
    for (const currentHunk of currentHunks) {
      for (const targetHunk of targetHunks) {
        const overlap = this.findLineOverlap(currentHunk, targetHunk);
        if (overlap) {
          overlappingRanges.push(overlap);
        }
      }
    }

    if (overlappingRanges.length === 0) {
      return null; // No conflicts in this file
    }

    // Determine conflict severity
    const maxSeverity = overlappingRanges.reduce((max, range) => {
      const severityLevels = { low: 1, medium: 2, high: 3 };
      return severityLevels[range.severity] > severityLevels[max] ? range.severity : max;
    }, 'low' as 'low' | 'medium' | 'high');

    return {
      file: filePath,
      type: 'content',
      severity: maxSeverity,
      lineStart: Math.min(...overlappingRanges.map(r => r.start)),
      lineEnd: Math.max(...overlappingRanges.map(r => r.end)),
      description: `Overlapping changes in ${overlappingRanges.length} region(s)`,
      conflictMarkers: overlappingRanges.length
    };
  }

  /**
   * Find overlapping line ranges between two hunks
   */
  private findLineOverlap(hunk1: any, hunk2: any): { start: number; end: number; severity: 'low' | 'medium' | 'high' } | null {
    const range1 = { start: hunk1.newStart, end: hunk1.newStart + hunk1.newLines };
    const range2 = { start: hunk2.newStart, end: hunk2.newStart + hunk2.newLines };

    const overlapStart = Math.max(range1.start, range2.start);
    const overlapEnd = Math.min(range1.end, range2.end);

    if (overlapStart >= overlapEnd) {
      return null; // No overlap
    }

    const overlapSize = overlapEnd - overlapStart;
    const severity = overlapSize > 20 ? 'high' : overlapSize > 5 ? 'medium' : 'low';

    return {
      start: overlapStart,
      end: overlapEnd,
      severity
    };
  }

  /**
   * Parse conflicts from worktree merge attempt
   */
  private async parseWorktreeConflicts(execOptions: any, detailed: boolean): Promise<ConflictRegion[]> {
    try {
      // Get list of conflicted files
      const statusResult = await gitExec.exec('status', ['--porcelain'], execOptions);
      const conflicts: ConflictRegion[] = [];

      const lines = statusResult.stdout.split('\n').filter(line => line.trim());
      for (const line of lines) {
        if (line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('DD ')) {
          const filePath = line.substring(3);
          const conflict = await this.analyzeWorktreeFileConflict(filePath, execOptions, detailed);
          if (conflict) {
            conflicts.push(conflict);
          }
        }
      }

      return conflicts;
    } catch {
      return []; // If we can't parse conflicts, assume none
    }
  }

  /**
   * Analyze a specific conflicted file in worktree
   */
  private async analyzeWorktreeFileConflict(filePath: string, execOptions: any, _detailed: boolean): Promise<ConflictRegion | null> {
    try {
      // Read file content to count conflict markers
      const catResult = await gitExec.exec('show', [`:${filePath}`], execOptions);
      const content = catResult.stdout;
      
      const conflictMarkers = (content.match(/^<{7}|^={7}|^>{7}/gm) || []).length;
      const lines = content.split('\n').length;

      // Estimate severity based on conflict marker density
      const severity = conflictMarkers > lines * 0.1 ? 'high' : 
                      conflictMarkers > lines * 0.05 ? 'medium' : 'low';

      return {
        file: filePath,
        type: 'content',
        severity,
        lineStart: 1,
        lineEnd: lines,
        description: `Merge conflict with ${Math.floor(conflictMarkers / 3)} conflict regions`,
        conflictMarkers: Math.floor(conflictMarkers / 3)
      };
    } catch {
      return null;
    }
  }

  /**
   * Generate conflict forecast
   */
  private generateConflictForecast(analysis: any, currentBranch: string, target: string, strategy: string): ConflictForecast {
    const conflicts = analysis.conflicts;
    const totalConflicts = conflicts.length;
    const highSeverityConflicts = conflicts.filter((c: ConflictRegion) => c.severity === 'high').length;
    const mediumSeverityConflicts = conflicts.filter((c: ConflictRegion) => c.severity === 'medium').length;

    let riskLevel: 'low' | 'medium' | 'high';
    let confidence: number;

    if (totalConflicts === 0) {
      riskLevel = 'low';
      confidence = 0.95;
    } else if (highSeverityConflicts > 0) {
      riskLevel = 'high';
      confidence = 0.85;
    } else if (mediumSeverityConflicts > totalConflicts / 2) {
      riskLevel = 'medium';
      confidence = 0.75;
    } else {
      riskLevel = 'low';
      confidence = 0.65;
    }

    return {
      riskLevel,
      confidence,
      estimatedConflicts: totalConflicts,
      recommendations: this.generateRecommendations(conflicts, strategy, currentBranch, target)
    };
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(conflicts: ConflictRegion[], strategy: string, _currentBranch: string, _target: string): string[] {
    const recommendations: string[] = [];

    if (conflicts.length === 0) {
      recommendations.push('Merge can proceed safely with no expected conflicts');
      if (strategy === 'merge') {
        recommendations.push('Consider using --no-ff to preserve branch history');
      }
    } else {
      recommendations.push(`${conflicts.length} potential conflicts detected`);
      
      const highSeverityFiles = conflicts.filter(c => c.severity === 'high').map(c => c.file);
      if (highSeverityFiles.length > 0) {
        recommendations.push(`High-risk files requiring careful review: ${highSeverityFiles.join(', ')}`);
      }

      if (strategy === 'rebase') {
        recommendations.push('Consider using merge instead of rebase for complex conflicts');
      } else {
        recommendations.push('Consider rebasing feature branch to resolve conflicts incrementally');
      }

      recommendations.push('Review conflicting regions before proceeding with merge');
      recommendations.push('Ensure comprehensive testing after merge resolution');
    }

    return recommendations;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: MergePreflightResult): string {
    const parts: string[] = [];

    if (result.canMerge) {
      parts.push(`Merge ${result.targetBranch} → ${result.currentBranch} can proceed safely`);
    } else {
      parts.push(`Merge ${result.targetBranch} → ${result.currentBranch} has issues`);
    }

    if (result.conflicts.length > 0) {
      parts.push(`${result.conflicts.length} potential conflicts`);
    }

    if (result.policyViolations.length > 0) {
      parts.push(`${result.policyViolations.length} policy violations`);
    }

    if (result.forecast) {
      parts.push(`Risk: ${result.forecast.riskLevel}`);
    }

    return parts.join(', ');
  }
}
