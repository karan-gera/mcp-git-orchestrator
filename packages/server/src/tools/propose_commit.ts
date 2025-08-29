/**
 * Propose Commit Tool
 * 
 * Analyzes changed files and generates conventional commit messages
 * with intelligent scope detection and type heuristics.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { gitExec, GitError } from '../git/index.js';
import { parseGitStatus } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { CommitProposal } from '../types.js';
import { readFile } from 'fs/promises';
import { join, sep } from 'path';

export interface ProposeCommitArgs {
  /** Files to include in the commit (default: all staged files) */
  changed_files?: string[];
  /** Include detailed analysis in metadata */
  include_analysis?: boolean;
  /** Custom commit message prefix */
  prefix?: string;
  /** Force a specific commit type */
  force_type?: string;
  /** Force a specific scope */
  force_scope?: string;
}

interface FileGroup {
  scope: string;
  files: string[];
  type: string;
  confidence: number;
  packageName?: string;
  packagePath?: string;
}

interface CommitAnalysis {
  groups: FileGroup[];
  primaryGroup: FileGroup;
  suggestedType: string;
  suggestedScope?: string;
  confidence: number;
  trailers: Array<{ key: string; value: string }>;
}

export class ProposeCommitTool extends BaseTool {
  constructor() {
    super('propose_commit');
  }

  getDescription(): string {
    return 'Generate conventional commit messages based on changed files with intelligent scope detection';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files to analyze (default: all staged files)'
        },
        include_analysis: {
          type: 'boolean',
          description: 'Include detailed analysis in metadata',
          default: false
        },
        prefix: {
          type: 'string',
          description: 'Custom prefix for commit message'
        },
        force_type: {
          type: 'string',
          description: 'Force a specific commit type (feat, fix, docs, etc.)'
        },
        force_scope: {
          type: 'string',
          description: 'Force a specific scope instead of auto-detection'
        }
      }
    };
  }

  async execute(args: ProposeCommitArgs = {}, context?: ToolContext): Promise<ToolResult<CommitProposal>> {
    const {
      changed_files,
      include_analysis = false,
      prefix,
      force_type,
      force_scope
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
      let filesToAnalyze: string[];
      if (changed_files) {
        filesToAnalyze = changed_files;
      } else {
        // Get staged files by default
        const statusResult = await gitExec.exec('status', ['--porcelain=v1'], execOptions);
        const status = parseGitStatus(statusResult.stdout);
        filesToAnalyze = status.staged.map(file => file.path);
        
        if (filesToAnalyze.length === 0) {
          return createErrorResult(
            'No staged files found. Stage files first or specify changed_files.',
            undefined,
            { stagedFiles: 0 }
          );
        }
      }

      // Load policy for commit style validation
      const policyResult = await policyLoader.loadPolicy(repositoryPath);
      const policy = policyResult.policy;

      // Analyze files and generate commit proposal
      const analysis = await this.analyzeFiles(filesToAnalyze, repositoryPath);
      const proposal = this.generateCommitProposal(analysis, policy, {
        prefix,
        forceType: force_type,
        forceScope: force_scope
      });

      // Validate proposed commit against policy
      const validation = policyLoader.validateCommitMessage(policy, 
        `${proposal.subject}${proposal.body ? '\n\n' + proposal.body : ''}`);

      const metadata: Record<string, any> = {
        repositoryPath,
        fileCount: filesToAnalyze.length,
        analysis: include_analysis ? analysis : undefined,
        policyValidation: validation,
        confidence: analysis.confidence
      };

      // Add warnings if validation failed
      const warnings: string[] = [];
      if (!validation.valid) {
        warnings.push(...validation.errors);
      }
      if (warnings.length > 0) {
        metadata.warnings = warnings;
      }

      // Generate human-readable summary
      const summary = this.generateSummary(proposal, analysis, validation.valid);

      return createSuccessResult(proposal, summary, metadata);

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
   * Analyze files and group them by scope and type
   */
  private async analyzeFiles(files: string[], repositoryPath: string): Promise<CommitAnalysis> {
    const groups: FileGroup[] = [];
    const scopeMap = new Map<string, FileGroup>();

    // Group files by detected scope
    for (const file of files) {
      const scope = await this.detectScope(file, repositoryPath);
      const type = this.detectType(file);
      
      const key = `${scope}:${type}`;
      if (!scopeMap.has(key)) {
        scopeMap.set(key, {
          scope,
          files: [],
          type,
          confidence: 0,
          packageName: await this.getPackageName(file, repositoryPath)
        });
      }
      
      const group = scopeMap.get(key)!;
      group.files.push(file);
      group.confidence = this.calculateConfidence(group.files, group.type);
    }

    groups.push(...scopeMap.values());

    // Find primary group (most files or highest confidence)
    const primaryGroup = groups.reduce((best, current) => {
      const bestScore = best.files.length * best.confidence;
      const currentScore = current.files.length * current.confidence;
      return currentScore > bestScore ? current : best;
    });

    // Detect potential trailers from CODEOWNERS
    const trailers = await this.detectTrailers(files, repositoryPath);

    return {
      groups,
      primaryGroup,
      suggestedType: primaryGroup.type,
      suggestedScope: primaryGroup.scope !== 'root' ? primaryGroup.scope : undefined,
      confidence: primaryGroup.confidence,
      trailers
    };
  }

  /**
   * Detect scope based on file path and package.json locations
   */
  private async detectScope(filePath: string, repositoryPath: string): Promise<string> {
    const pathParts = filePath.split(sep);
    
    // Check for package-based scope
    let currentPath = repositoryPath;
    for (let i = 0; i < pathParts.length - 1; i++) {
      currentPath = join(currentPath, pathParts[i]);
      try {
        const packageJsonPath = join(currentPath, 'package.json');
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
        
        // Extract scope from package name
        if (packageJson.name) {
          const name = packageJson.name;
          if (name.includes('/')) {
            return name.split('/').pop() || pathParts[i];
          }
          if (name.startsWith('@')) {
            return name.slice(1);
          }
          // For workspace packages, use directory name
          return pathParts[i];
        }
      } catch {
        // No package.json or invalid JSON, continue
      }
    }

    // Fallback to directory-based scope
    if (pathParts.length > 1) {
      // Common patterns
      if (pathParts[0] === 'packages' && pathParts.length > 2) {
        return pathParts[1]; // packages/server -> server
      }
      if (pathParts[0] === 'src' || pathParts[0] === 'lib') {
        return pathParts[1] || 'core';
      }
      return pathParts[0];
    }

    return 'root';
  }

  /**
   * Detect commit type based on file patterns
   */
  private detectType(filePath: string): string {
    const path = filePath.toLowerCase();
    const pathParts = path.split(sep);

    // Test files
    if (path.includes('test') || path.includes('spec') || path.endsWith('.test.ts') || path.endsWith('.spec.ts')) {
      return 'test';
    }

    // Documentation
    if (path.endsWith('.md') || path.includes('docs') || path.includes('readme')) {
      return 'docs';
    }

    // Configuration files
    if (this.isConfigFile(path)) {
      return 'chore';
    }

    // CI/CD files
    if (path.includes('.github') || path.includes('ci') || path.includes('deploy')) {
      return 'ci';
    }

    // Build files
    if (this.isBuildFile(path)) {
      return 'build';
    }

    // Performance files
    if (path.includes('perf') || path.includes('benchmark')) {
      return 'perf';
    }

    // Style files
    if (this.isStyleFile(path)) {
      return 'style';
    }

    // Source code - distinguish between feat and fix
    if (this.isSourceFile(path)) {
      // Heuristic: new files are likely features
      if (pathParts.some(part => part.includes('new') || part.includes('add'))) {
        return 'feat';
      }
      
      // Files with 'fix', 'bug', 'patch' in name/path
      if (pathParts.some(part => part.includes('fix') || part.includes('bug') || part.includes('patch'))) {
        return 'fix';
      }

      // Default to feat for new functionality
      return 'feat';
    }

    // Default fallback
    return 'chore';
  }

  private isConfigFile(path: string): boolean {
    const configPatterns = [
      '.json', '.yaml', '.yml', '.toml', '.ini', '.conf',
      'config', 'settings', '.env', 'tsconfig', 'package.json',
      '.gitignore', '.editorconfig', 'dockerfile'
    ];
    return configPatterns.some(pattern => path.includes(pattern));
  }

  private isBuildFile(path: string): boolean {
    const buildPatterns = [
      'webpack', 'rollup', 'vite', 'esbuild', 'babel',
      'makefile', 'gulpfile', 'gruntfile', 'package.json'
    ];
    return buildPatterns.some(pattern => path.includes(pattern));
  }

  private isStyleFile(path: string): boolean {
    const stylePatterns = [
      '.css', '.scss', '.sass', '.less', '.stylus',
      'prettier', 'eslint', 'format'
    ];
    return stylePatterns.some(pattern => path.includes(pattern));
  }

  private isSourceFile(path: string): boolean {
    const sourceExtensions = [
      '.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go',
      '.java', '.c', '.cpp', '.h', '.hpp'
    ];
    return sourceExtensions.some(ext => path.endsWith(ext));
  }

  /**
   * Calculate confidence score for a group
   */
  private calculateConfidence(files: string[], type: string): number {
    let confidence = 0.5; // Base confidence

    // More files = higher confidence
    confidence += Math.min(files.length * 0.1, 0.3);

    // Type-specific confidence adjustments
    switch (type) {
      case 'test':
      case 'docs':
      case 'ci':
        confidence += 0.3; // High confidence for clear patterns
        break;
      case 'feat':
      case 'fix':
        confidence += 0.2; // Medium confidence
        break;
      case 'chore':
        confidence -= 0.1; // Lower confidence for catch-all
        break;
    }

    return Math.min(Math.max(confidence, 0.1), 1.0);
  }

  /**
   * Get package name from nearest package.json
   */
  private async getPackageName(filePath: string, repositoryPath: string): Promise<string | undefined> {
    const pathParts = filePath.split(sep);
    let currentPath = repositoryPath;

    for (let i = 0; i < pathParts.length; i++) {
      try {
        const packageJsonPath = join(currentPath, 'package.json');
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
        return packageJson.name;
      } catch {
        // Continue searching
      }
      
      if (i < pathParts.length - 1) {
        currentPath = join(currentPath, pathParts[i]);
      }
    }

    return undefined;
  }

  /**
   * Detect potential trailers from CODEOWNERS file
   */
  private async detectTrailers(files: string[], repositoryPath: string): Promise<Array<{ key: string; value: string }>> {
    const trailers: Array<{ key: string; value: string }> = [];

    try {
      const codeownersPath = join(repositoryPath, '.github', 'CODEOWNERS');
      const codeowners = await readFile(codeownersPath, 'utf-8');
      
      // Parse CODEOWNERS for relevant files
      const owners = new Set<string>();
      for (const file of files) {
        const lines = codeowners.split('\n');
        for (const line of lines) {
          if (line.trim() && !line.startsWith('#')) {
            const [pattern, ...fileOwners] = line.trim().split(/\s+/);
            if (this.matchesPattern(file, pattern)) {
              fileOwners.forEach(owner => owners.add(owner));
            }
          }
        }
      }

      // Convert owners to trailers
      if (owners.size > 0) {
        const ownerList = Array.from(owners).join(', ');
        trailers.push({ key: 'Reviewed-by', value: ownerList });
      }

    } catch {
      // CODEOWNERS file doesn't exist or couldn't be read
    }

    return trailers;
  }

  /**
   * Simple glob pattern matching
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return filePath.startsWith(pattern.slice(0, -1));
    }
    if (pattern.startsWith('*')) {
      return filePath.endsWith(pattern.slice(1));
    }
    return filePath === pattern || filePath.startsWith(pattern + '/');
  }

  /**
   * Generate commit proposal from analysis
   */
  private generateCommitProposal(
    analysis: CommitAnalysis, 
    policy: any,
    options: { prefix?: string; forceType?: string; forceScope?: string }
  ): CommitProposal {
    const { prefix, forceType, forceScope } = options;
    
    const type = forceType || analysis.suggestedType;
    const scope = forceScope || analysis.suggestedScope;
    
    // Build subject line
    let subject = prefix ? `${prefix} ` : '';
    subject += type;
    if (scope) {
      subject += `(${scope})`;
    }
    subject += ': ';

    // Generate description based on files and type
    const description = this.generateDescription(analysis, type);
    subject += description;

    // Generate body for important changes
    let body: string | undefined;
    if (policy.commit_style?.require_body_for?.includes(type)) {
      body = this.generateBody(analysis);
    }

    return {
      subject,
      body,
      trailers: analysis.trailers
    };
  }

  /**
   * Generate commit description
   */
  private generateDescription(analysis: CommitAnalysis, type: string): string {
    const fileCount = analysis.groups.reduce((sum, group) => sum + group.files.length, 0);
    const primaryGroup = analysis.primaryGroup;

    // Type-specific descriptions
    switch (type) {
      case 'feat':
        return `add ${this.pluralize('feature', fileCount)} to ${primaryGroup.scope}`;
      case 'fix':
        return `resolve ${this.pluralize('issue', fileCount)} in ${primaryGroup.scope}`;
      case 'docs':
        return `update ${this.pluralize('documentation', fileCount)}`;
      case 'test':
        return `add ${this.pluralize('test', fileCount)} for ${primaryGroup.scope}`;
      case 'chore':
        return `update ${this.pluralize('configuration', fileCount)}`;
      case 'style':
        return `improve code formatting and style`;
      case 'refactor':
        return `refactor ${primaryGroup.scope} implementation`;
      case 'perf':
        return `improve performance in ${primaryGroup.scope}`;
      case 'ci':
        return `update CI/CD configuration`;
      case 'build':
        return `update build configuration`;
      default:
        return `update ${primaryGroup.scope} ${this.pluralize('file', fileCount)}`;
    }
  }

  /**
   * Generate commit body for detailed explanation
   */
  private generateBody(analysis: CommitAnalysis): string {
    const lines: string[] = [];
    
    lines.push('Changes include:');
    
    for (const group of analysis.groups) {
      const fileList = group.files.length > 3 
        ? `${group.files.slice(0, 3).join(', ')} and ${group.files.length - 3} more`
        : group.files.join(', ');
      
      lines.push(`- ${group.type} (${group.scope}): ${fileList}`);
    }

    return lines.join('\n');
  }

  /**
   * Simple pluralization helper
   */
  private pluralize(word: string, count: number): string {
    if (count === 1) return word;
    
    const irregulars: Record<string, string> = {
      'feature': 'features',
      'issue': 'issues',
      'documentation': 'documentation',
      'test': 'tests',
      'configuration': 'configurations',
      'file': 'files'
    };

    return irregulars[word] || `${word}s`;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(proposal: CommitProposal, analysis: CommitAnalysis, isValid: boolean): string {
    const parts: string[] = [];
    
    parts.push(`Proposed: "${proposal.subject}"`);
    
    if (analysis.confidence < 0.7) {
      parts.push(`(confidence: ${Math.round(analysis.confidence * 100)}%)`);
    }
    
    if (!isValid) {
      parts.push('⚠️ Policy validation failed');
    }

    return parts.join(' ');
  }
}
