/**
 * Conflict Map Tool
 * 
 * Scans files for Git conflict markers and provides detailed analysis
 * with resolution suggestions and priority ordering.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitStatus } from '../git/index.js';
import type { ConflictMapResult, ConflictFile, ConflictMarker, ResolutionSuggestion } from '../types.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

export interface ConflictMapArgs {
  /** Specific files to analyze (default: all conflicted files) */
  files?: string[];
  /** Include resolution suggestions */
  include_suggestions?: boolean;
  /** Include line content in markers */
  include_content?: boolean;
  /** Maximum lines of content to include per marker */
  content_limit?: number;
}

export class ConflictMapTool extends BaseTool {
  constructor() {
    super('conflict_map');
  }

  getDescription(): string {
    return 'Analyze Git conflict markers and provide resolution guidance with priority ordering';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files to analyze (default: all conflicted files)'
        },
        include_suggestions: {
          type: 'boolean',
          description: 'Include resolution suggestions',
          default: true
        },
        include_content: {
          type: 'boolean',
          description: 'Include line content in conflict markers',
          default: false
        },
        content_limit: {
          type: 'number',
          description: 'Maximum lines of content per marker',
          default: 5,
          minimum: 1,
          maximum: 20
        }
      }
    };
  }

  async execute(args: ConflictMapArgs = {}, context?: ToolContext): Promise<ToolResult<ConflictMapResult>> {
    const {
      files,
      include_suggestions = true,
      include_content = false,
      content_limit = 5
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

      // Get files to analyze
      const filesToAnalyze = files || await this.getConflictedFiles(execOptions);
      
      if (filesToAnalyze.length === 0) {
        return createSuccessResult({
          conflictedFiles: [],
          totalConflicts: 0,
          resolutionOrder: [],
          suggestions: []
        }, 'No conflicts found', { repositoryPath });
      }

      // Analyze each file for conflict markers
      const conflictFiles: ConflictFile[] = [];
      let totalConflicts = 0;

      for (const filePath of filesToAnalyze) {
        try {
          const conflictFile = await this.analyzeFileConflicts(
            filePath, 
            repositoryPath, 
            include_content, 
            content_limit
          );
          
          if (conflictFile.conflicts.length > 0) {
            conflictFiles.push(conflictFile);
            totalConflicts += conflictFile.conflicts.length;
          }
        } catch (error) {
          // Skip files that can't be read (might be binary or deleted)
          continue;
        }
      }

      // Generate resolution order and suggestions
      const resolutionOrder = this.generateResolutionOrder(conflictFiles);
      const suggestions = include_suggestions ? this.generateResolutionSuggestions(conflictFiles) : [];

      const result: ConflictMapResult = {
        conflictedFiles: conflictFiles,
        totalConflicts,
        resolutionOrder,
        suggestions
      };

      const metadata = {
        repositoryPath,
        filesAnalyzed: filesToAnalyze.length,
        conflictedFilesFound: conflictFiles.length,
        includeContent: include_content,
        includeSuggestions: include_suggestions
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
   * Get list of conflicted files from Git status
   */
  private async getConflictedFiles(execOptions: any): Promise<string[]> {
    const statusResult = await gitExec.exec('status', ['--porcelain=v1'], execOptions);
    const status = parseGitStatus(statusResult.stdout);
    
    // Find files with unmerged status (both modified, added by us/them, etc.)
    const conflictedFiles: string[] = [];
    
    for (const file of status.staged) {
      if (file.status === 'unmerged' || this.isConflictStatus(file.status)) {
        conflictedFiles.push(file.path);
      }
    }
    
    for (const file of status.unstaged) {
      if (file.status === 'unmerged' || this.isConflictStatus(file.status)) {
        conflictedFiles.push(file.path);
      }
    }

    return [...new Set(conflictedFiles)]; // Remove duplicates
  }

  /**
   * Check if status indicates conflict
   */
  private isConflictStatus(status: string): boolean {
    // Git status codes that indicate conflicts
    const conflictStatuses = ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD'];
    return conflictStatuses.includes(status);
  }

  /**
   * Analyze a single file for conflict markers
   */
  private async analyzeFileConflicts(
    filePath: string, 
    repositoryPath: string, 
    includeContent: boolean,
    contentLimit: number
  ): Promise<ConflictFile> {
    const fullPath = join(repositoryPath, filePath);
    const content = await readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    
    const conflicts: ConflictMarker[] = [];
    let currentConflict: Partial<ConflictMarker> | null = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      
      if (line.startsWith('<<<<<<<')) {
        // Start of conflict
        currentConflict = {
          startLine: lineNumber,
          oursBranch: this.extractBranchName(line),
          oursLines: [],
          theirsLines: [],
          baseLines: []
        };
      } else if (line.startsWith('=======') && currentConflict) {
        // Separator - switch to 'theirs' section
        currentConflict.separatorLine = lineNumber;
      } else if (line.startsWith('>>>>>>>') && currentConflict) {
        // End of conflict
        currentConflict.endLine = lineNumber;
        currentConflict.theirsBranch = this.extractBranchName(line);
        
        // Calculate conflict size and complexity
        const oursCount = currentConflict.oursLines?.length || 0;
        const theirsCount = currentConflict.theirsLines?.length || 0;
        currentConflict.size = oursCount + theirsCount;
        currentConflict.complexity = this.calculateComplexity(currentConflict);
        
        conflicts.push(currentConflict as ConflictMarker);
        currentConflict = null;
      } else if (currentConflict) {
        // Content lines
        if (!currentConflict.separatorLine) {
          // Before separator - 'ours' section
          if (includeContent && currentConflict.oursLines!.length < contentLimit) {
            currentConflict.oursLines!.push(line);
          } else if (!includeContent) {
            currentConflict.oursLines!.push(''); // Track count without content
          }
        } else {
          // After separator - 'theirs' section
          if (includeContent && currentConflict.theirsLines!.length < contentLimit) {
            currentConflict.theirsLines!.push(line);
          } else if (!includeContent) {
            currentConflict.theirsLines!.push(''); // Track count without content
          }
        }
      }
    }
    
    // Calculate file-level metrics
    const totalLines = lines.length;
    const conflictedLines = conflicts.reduce((sum, conflict) => sum + (conflict.size || 0), 0);
    const conflictDensity = totalLines > 0 ? conflictedLines / totalLines : 0;
    
    return {
      path: filePath,
      conflicts,
      totalConflicts: conflicts.length,
      conflictDensity,
      fileSize: content.length,
      priority: this.calculateFilePriority(filePath, conflicts, conflictDensity)
    };
  }

  /**
   * Extract branch name from conflict marker
   */
  private extractBranchName(line: string): string {
    const match = line.match(/^[<>]{7}\s*(.+)$/);
    return match ? match[1].trim() : 'unknown';
  }

  /**
   * Calculate complexity of a single conflict
   */
  private calculateComplexity(conflict: Partial<ConflictMarker>): 'low' | 'medium' | 'high' {
    const oursCount = conflict.oursLines?.length || 0;
    const theirsCount = conflict.theirsLines?.length || 0;
    const totalLines = oursCount + theirsCount;
    
    if (totalLines <= 5) return 'low';
    if (totalLines <= 15) return 'medium';
    return 'high';
  }

  /**
   * Calculate file priority for resolution order
   */
  private calculateFilePriority(filePath: string, conflicts: ConflictMarker[], density: number): number {
    let priority = 0;
    
    // Base priority on number of conflicts (more conflicts = higher priority)
    priority += conflicts.length * 10;
    
    // Adjust based on conflict density
    priority += density * 20;
    
    // Adjust based on file type importance
    const fileTypeWeight = this.getFileTypeWeight(filePath);
    priority += fileTypeWeight;
    
    // Adjust based on complexity
    const complexityWeight = conflicts.reduce((sum, conflict) => {
      switch (conflict.complexity) {
        case 'high': return sum + 15;
        case 'medium': return sum + 10;
        case 'low': return sum + 5;
        default: return sum;
      }
    }, 0);
    priority += complexityWeight;
    
    return Math.round(priority);
  }

  /**
   * Get weight based on file type importance
   */
  private getFileTypeWeight(filePath: string): number {
    const path = filePath.toLowerCase();
    
    // Critical files
    if (path.includes('package.json') || path.includes('readme') || path.includes('license')) {
      return 30;
    }
    
    // Configuration files
    if (path.endsWith('.config.js') || path.endsWith('.config.ts') || 
        path.includes('tsconfig') || path.includes('webpack') || 
        path.includes('babel') || path.includes('.env')) {
      return 25;
    }
    
    // Source code files
    if (path.endsWith('.ts') || path.endsWith('.js') || path.endsWith('.tsx') || path.endsWith('.jsx')) {
      return 20;
    }
    
    // Test files
    if (path.includes('test') || path.includes('spec')) {
      return 15;
    }
    
    // Documentation
    if (path.endsWith('.md') || path.includes('docs')) {
      return 10;
    }
    
    // Other files
    return 5;
  }

  /**
   * Generate resolution order based on priority
   */
  private generateResolutionOrder(conflictFiles: ConflictFile[]): string[] {
    return conflictFiles
      .sort((a, b) => b.priority - a.priority) // Descending priority
      .map(file => file.path);
  }

  /**
   * Generate resolution suggestions
   */
  private generateResolutionSuggestions(conflictFiles: ConflictFile[]): ResolutionSuggestion[] {
    const suggestions: ResolutionSuggestion[] = [];
    
    // General suggestions
    suggestions.push({
      type: 'general',
      priority: 'high',
      title: 'Resolution Order',
      description: 'Resolve conflicts in order of priority to minimize merge complexity',
      files: this.generateResolutionOrder(conflictFiles)
    });
    
    // File-specific suggestions
    for (const file of conflictFiles) {
      if (file.conflicts.length > 5) {
        suggestions.push({
          type: 'file-specific',
          priority: 'high',
          title: `High Conflict Density: ${file.path}`,
          description: `File has ${file.conflicts.length} conflicts. Consider breaking into smaller changes.`,
          files: [file.path]
        });
      }
      
      // Check for complex conflicts
      const complexConflicts = file.conflicts.filter(c => c.complexity === 'high');
      if (complexConflicts.length > 0) {
        suggestions.push({
          type: 'conflict-specific',
          priority: 'medium',
          title: `Complex Conflicts: ${file.path}`,
          description: `${complexConflicts.length} complex conflicts detected. Review carefully and consider manual resolution.`,
          files: [file.path]
        });
      }
    }
    
    // Strategy suggestions
    const totalFiles = conflictFiles.length;
    if (totalFiles > 10) {
      suggestions.push({
        type: 'strategy',
        priority: 'medium',
        title: 'Large Merge Conflict',
        description: `${totalFiles} files have conflicts. Consider resolving in batches or rebasing incrementally.`,
        files: conflictFiles.map(f => f.path)
      });
    }
    
    // Tool suggestions
    const criticalFiles = conflictFiles.filter(f => f.path.includes('package.json') || f.path.includes('config'));
    if (criticalFiles.length > 0) {
      suggestions.push({
        type: 'tool',
        priority: 'high',
        title: 'Critical File Conflicts',
        description: 'Configuration files have conflicts. Verify functionality after resolution.',
        files: criticalFiles.map(f => f.path)
      });
    }
    
    return suggestions.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: ConflictMapResult): string {
    const { conflictedFiles, totalConflicts } = result;
    
    if (conflictedFiles.length === 0) {
      return 'No conflicts found';
    }
    
    const parts: string[] = [];
    
    parts.push(`Found ${totalConflicts} conflicts in ${conflictedFiles.length} ${this.pluralize('file', conflictedFiles.length)}`);
    
    // Highlight high-priority files
    const highPriorityFiles = conflictedFiles
      .filter(f => f.priority > 50)
      .slice(0, 3);
    
    if (highPriorityFiles.length > 0) {
      parts.push(`Priority files: ${highPriorityFiles.map(f => f.path).join(', ')}`);
    }
    
    // Complexity summary
    const complexConflicts = conflictedFiles.reduce((sum, file) => 
      sum + file.conflicts.filter(c => c.complexity === 'high').length, 0
    );
    
    if (complexConflicts > 0) {
      parts.push(`${complexConflicts} complex conflicts require careful review`);
    }
    
    return parts.join(', ');
  }

  /**
   * Simple pluralization helper
   */
  private pluralize(word: string, count: number): string {
    return count === 1 ? word : `${word}s`;
  }
}
