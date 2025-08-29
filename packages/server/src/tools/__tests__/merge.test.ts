/**
 * Merge Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MergeTool } from '../merge.js';
import { gitExec } from '../../git/index.js';
import { policyLoader } from '../../policy/index.js';

// Mock dependencies
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn()
  },
  parseGitDiff: vi.fn(),
  GitError: class GitError extends Error {
    constructor(code: number, message: string, stderr: string, command: string) {
      super(message);
      this.name = 'GitError';
    }
  }
}));

vi.mock('../../policy/index.js', () => ({
  policyLoader: {
    loadPolicy: vi.fn(),
    isBranchProtected: vi.fn()
  }
}));

// Mock the parser
const mockParseGitDiff = vi.fn();
vi.mocked(vi.importActual('../../git/index.js')).parseGitDiff = mockParseGitDiff;

describe('MergeTool', () => {
  let tool: MergeTool;
  const mockGitExec = vi.mocked(gitExec);
  const mockPolicyLoader = vi.mocked(policyLoader);

  beforeEach(() => {
    tool = new MergeTool();
    vi.clearAllMocks();
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockPolicyLoader.loadPolicy.mockResolvedValue({
      policy: {
        merge_strategy: {
          require_pr: false,
          require_clean_tree: true,
          denied_patterns: []
        },
        protected_branches: ['main', 'master']
      },
      source: 'file',
      validation: { isValid: true, errors: [], warnings: [] },
      warnings: []
    });
    
    mockPolicyLoader.isBranchProtected.mockReturnValue(false);
    
    mockParseGitDiff.mockReturnValue({
      files: [],
      hunks: []
    });
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Analyze merge operations and forecast potential conflicts without executing merges');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('target');
      expect(schema.properties).toHaveProperty('strategy');
      expect(schema).toHaveProperty('required', ['target']);
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        });
    });

    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('validates target branch exists', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockRejectedValueOnce(new Error('Target branch does not exist'));

      const result = await tool.execute({ target: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('prevents analysis from detached HEAD', async () => {
      mockGitExec.exec
        .mockRejectedValueOnce(new Error('Not on a branch'));

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('detached HEAD');
    });

    it('checks for uncommitted changes', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: 'M  file.txt',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        });

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('uncommitted changes');
    });

    it('analyzes clean merge with no conflicts', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: 'def456',
          stderr: '',
          exitCode: 0,
          command: 'git merge-base feature-branch main'
        })
        .mockResolvedValueOnce({
          stdout: 'diff --git a/file1.txt b/file1.txt\n+new content',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 feature-branch'
        })
        .mockResolvedValueOnce({
          stdout: 'diff --git a/file2.txt b/file2.txt\n+other content',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 main'
        });

      mockParseGitDiff
        .mockReturnValueOnce({
          files: [{ path: 'file1.txt', status: 'modified' }],
          hunks: []
        })
        .mockReturnValueOnce({
          files: [{ path: 'file2.txt', status: 'modified' }],
          hunks: []
        });

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(true);
      expect(result.data.canMerge).toBe(true);
      expect(result.data.conflicts).toHaveLength(0);
      expect(result.data.forecast.riskLevel).toBe('low');
      expect(result.summary).toContain('can proceed safely');
    });

    it('detects potential conflicts from overlapping changes', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: 'def456',
          stderr: '',
          exitCode: 0,
          command: 'git merge-base feature-branch main'
        })
        .mockResolvedValueOnce({
          stdout: 'diff --git a/shared.txt b/shared.txt\n@@ -1,5 +1,5 @@\n-old line\n+new line from feature',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 feature-branch'
        })
        .mockResolvedValueOnce({
          stdout: 'diff --git a/shared.txt b/shared.txt\n@@ -1,5 +1,5 @@\n-old line\n+new line from main',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 main'
        });

      // Mock overlapping file changes
      mockParseGitDiff
        .mockReturnValueOnce({
          files: [{ path: 'shared.txt', status: 'modified' }],
          hunks: [{
            file: 'shared.txt',
            oldStart: 1,
            oldLines: 5,
            newStart: 1,
            newLines: 5,
            header: '@@ -1,5 +1,5 @@',
            lines: []
          }]
        })
        .mockReturnValueOnce({
          files: [{ path: 'shared.txt', status: 'modified' }],
          hunks: [{
            file: 'shared.txt',
            oldStart: 1,
            oldLines: 5,
            newStart: 1,
            newLines: 5,
            header: '@@ -1,5 +1,5 @@',
            lines: []
          }]
        });

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(true);
      expect(result.data.canMerge).toBe(false);
      expect(result.data.conflicts).toHaveLength(1);
      expect(result.data.conflicts[0].file).toBe('shared.txt');
      expect(result.data.forecast.riskLevel).toBe('medium');
      expect(result.summary).toContain('has issues');
    });

    it('analyzes merge using worktree method', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git worktree add'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git merge --no-commit --no-ff main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git worktree remove --force'
        });

      const result = await tool.execute({ 
        target: 'main', 
        use_worktree: true 
      });

      expect(result.success).toBe(true);
      expect(result.data.canMerge).toBe(true);
      expect(result.metadata?.analysisMethod).toBe('worktree');
    });

    it('handles worktree merge conflicts', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git worktree add'
        })
        .mockRejectedValueOnce(new Error('Merge conflict'))
        .mockResolvedValueOnce({
          stdout: 'UU conflicted.txt',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: '<<<<<<< HEAD\ncontent\n=======\nother content\n>>>>>>> main',
          stderr: '',
          exitCode: 0,
          command: 'git show :conflicted.txt'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git worktree remove --force'
        });

      const result = await tool.execute({ 
        target: 'main', 
        use_worktree: true 
      });

      expect(result.success).toBe(true);
      expect(result.data.canMerge).toBe(false);
      expect(result.data.conflicts).toHaveLength(1);
      expect(result.data.conflicts[0].file).toBe('conflicted.txt');
    });

    it('checks policy violations for protected branches', async () => {
      mockPolicyLoader.isBranchProtected.mockReturnValue(true);
      mockPolicyLoader.loadPolicy.mockResolvedValue({
        policy: {
          merge_strategy: {
            require_pr: true,
            require_clean_tree: true
          },
          protected_branches: ['main']
        },
        source: 'file',
        validation: { isValid: true, errors: [], warnings: [] },
        warnings: []
      });

      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: 'def456',
          stderr: '',
          exitCode: 0,
          command: 'git merge-base feature-branch main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 feature-branch'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 main'
        });

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(true);
      expect(result.data.canMerge).toBe(false);
      expect(result.data.policyViolations).toContain('Cannot merge into protected branch \'main\' without pull request');
    });

    it('provides detailed analysis when requested', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: 'def456',
          stderr: '',
          exitCode: 0,
          command: 'git merge-base feature-branch main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 feature-branch'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 main'
        });

      const result = await tool.execute({ 
        target: 'main', 
        detailed_analysis: true 
      });

      expect(result.success).toBe(true);
      expect(result.data.analysis).toBeDefined();
      expect(result.data.analysis).toHaveProperty('mergeBase');
    });

    it('generates appropriate recommendations', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123',
          stderr: '',
          exitCode: 0,
          command: 'git rev-parse --verify main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain'
        })
        .mockResolvedValueOnce({
          stdout: 'def456',
          stderr: '',
          exitCode: 0,
          command: 'git merge-base feature-branch main'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 feature-branch'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git diff def456 main'
        });

      const result = await tool.execute({ target: 'main' });

      expect(result.success).toBe(true);
      expect(result.data.forecast.recommendations).toContain('Merge can proceed safely with no expected conflicts');
      expect(result.data.forecast.confidence).toBeGreaterThan(0.9);
    });
  });
});
