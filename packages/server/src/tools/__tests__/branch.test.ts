/**
 * Branch Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BranchTool } from '../branch.js';
import { gitExec } from '../../git/index.js';
import { policyLoader } from '../../policy/index.js';

// Mock dependencies
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn(),
    createSafetySnapshot: vi.fn()
  },
  parseGitBranches: vi.fn(),
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
    validateBranchName: vi.fn(),
    isBranchProtected: vi.fn()
  }
}));

// Mock the parser
const mockParseGitBranches = vi.fn();
vi.mocked(vi.importActual('../../git/index.js')).parseGitBranches = mockParseGitBranches;

describe('BranchTool', () => {
  let tool: BranchTool;
  const mockGitExec = vi.mocked(gitExec);
  const mockPolicyLoader = vi.mocked(policyLoader);

  beforeEach(() => {
    tool = new BranchTool();
    vi.clearAllMocks();
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockPolicyLoader.loadPolicy.mockResolvedValue({
      policy: {
        branch_naming: {
          pattern: '^(feat|fix|docs|chore)\/[a-z0-9-]+$',
          max_length: 50,
          allowed_prefixes: ['feat/', 'fix/', 'docs/', 'chore/'],
          forbidden_patterns: []
        },
        protected_branches: ['main', 'master', 'production'],
        safety_snapshots: {
          auto_create: true,
          trigger_operations: ['branch']
        }
      },
      source: 'file',
      validation: { isValid: true, errors: [], warnings: [] },
      warnings: []
    });
    
    mockPolicyLoader.validateBranchName.mockReturnValue({
      valid: true,
      errors: []
    });
    
    mockPolicyLoader.isBranchProtected.mockReturnValue(false);
    
    mockParseGitBranches.mockReturnValue([
      { name: 'main', current: true, upstream: 'origin/main' },
      { name: 'feature-branch', current: false, upstream: undefined },
      { name: 'origin/develop', current: false, upstream: undefined }
    ]);
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Manage Git branches (create, switch, delete) with policy-compliant naming');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('operation');
      expect(schema.properties.operation.enum).toEqual(['create', 'switch', 'delete', 'list']);
      expect(schema).toHaveProperty('required', ['operation']);
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'main',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'main|*|origin/main\nfeature-branch||',
          stderr: '',
          exitCode: 0,
          command: 'git branch -a --format=...'
        });
    });

    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({ operation: 'list' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('requires branch name for non-list operations', async () => {
      const result = await tool.execute({ operation: 'create' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Branch name is required for create operation');
    });

    describe('create operation', () => {
      it('creates new branch successfully', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
          })
          .mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
            command: 'git branch feat/new-feature'
          });

        const result = await tool.execute({
          operation: 'create',
          name: 'feat/new-feature'
        });

        expect(result.success).toBe(true);
        expect(result.data.operation).toBe('create');
        expect(result.data.branch).toBe('feat/new-feature');
        expect(result.summary).toContain('create branch');
        expect(mockGitExec.exec).toHaveBeenCalledWith('branch', ['feat/new-feature'], expect.any(Object));
      });

      it('validates branch name against policy', async () => {
        mockPolicyLoader.validateBranchName.mockReturnValue({
          valid: false,
          errors: ['Branch name does not match pattern']
        });

        const result = await tool.execute({
          operation: 'create',
          name: 'InvalidBranchName'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Branch name validation failed');
      });

      it('checks for existing branch', async () => {
        mockParseGitBranches.mockReturnValue([
          { name: 'main', current: true },
          { name: 'feat/existing', current: false }
        ]);

        const result = await tool.execute({
          operation: 'create',
          name: 'feat/existing'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('already exists');
      });

      it('creates branch with tracking', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
          })
          .mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
            command: 'git branch --track feat/new-feature origin/develop'
          });

        const result = await tool.execute({
          operation: 'create',
          name: 'feat/new-feature',
          from: 'origin/develop',
          track: true
        });

        expect(result.success).toBe(true);
        expect(result.data.tracking).toBe(true);
        expect(mockGitExec.exec).toHaveBeenCalledWith('branch', ['--track', 'feat/new-feature', 'origin/develop'], expect.any(Object));
      });

      it('performs dry run without creating branch', async () => {
        const result = await tool.execute({
          operation: 'create',
          name: 'feat/new-feature',
          dry_run: true
        });

        expect(result.success).toBe(true);
        expect(result.summary).toContain('Would create');
        expect(result.metadata?.dryRun).toBe(true);
        expect(mockGitExec.exec).not.toHaveBeenCalledWith('branch', expect.arrayContaining(['feat/new-feature']), expect.any(Object));
      });

      it('creates safety snapshot when configured', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
          })
          .mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
            command: 'git branch feat/new-feature'
          });

        await tool.execute({
          operation: 'create',
          name: 'feat/new-feature'
        });

        expect(mockGitExec.createSafetySnapshot).toHaveBeenCalledWith('stash', 'Before branch creation');
      });
    });

    describe('switch operation', () => {
      it('switches to existing branch', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main\nfeature-branch||',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
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
            command: 'git switch feature-branch'
          });

        const result = await tool.execute({
          operation: 'switch',
          name: 'feature-branch'
        });

        expect(result.success).toBe(true);
        expect(result.data.operation).toBe('switch');
        expect(result.data.branch).toBe('feature-branch');
        expect(mockGitExec.exec).toHaveBeenCalledWith('switch', ['feature-branch'], expect.any(Object));
      });

      it('handles already on target branch', async () => {
        const result = await tool.execute({
          operation: 'switch',
          name: 'main'
        });

        expect(result.success).toBe(true);
        expect(result.data.message).toContain('Already on target branch');
      });

      it('checks for uncommitted changes', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main\nfeature-branch||',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
          })
          .mockResolvedValueOnce({
            stdout: 'M  file.txt',
            stderr: '',
            exitCode: 0,
            command: 'git status --porcelain'
          });

        const result = await tool.execute({
          operation: 'switch',
          name: 'feature-branch'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('uncommitted changes');
      });

      it('creates tracking branch for remote branch', async () => {
        mockParseGitBranches.mockReturnValue([
          { name: 'main', current: true },
          { name: 'origin/feature-branch', current: false }
        ]);

        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main\norigin/feature-branch||',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
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
            command: 'git switch -c feature-branch --track origin/feature-branch'
          });

        const result = await tool.execute({
          operation: 'switch',
          name: 'feature-branch'
        });

        expect(result.success).toBe(true);
        expect(mockGitExec.exec).toHaveBeenCalledWith('switch', ['-c', 'feature-branch', '--track', 'origin/feature-branch'], expect.any(Object));
      });
    });

    describe('delete operation', () => {
      it('deletes branch successfully', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main\nfeature-branch||',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
          })
          .mockResolvedValueOnce({
            stdout: 'feature-branch\n',
            stderr: '',
            exitCode: 0,
            command: 'git branch --merged'
          })
          .mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
            command: 'git branch -d feature-branch'
          });

        const result = await tool.execute({
          operation: 'delete',
          name: 'feature-branch'
        });

        expect(result.success).toBe(true);
        expect(result.data.operation).toBe('delete');
        expect(result.data.branch).toBe('feature-branch');
        expect(mockGitExec.exec).toHaveBeenCalledWith('branch', ['-d', 'feature-branch'], expect.any(Object));
      });

      it('prevents deletion of current branch', async () => {
        const result = await tool.execute({
          operation: 'delete',
          name: 'main'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot delete the current branch');
      });

      it('prevents deletion of protected branch', async () => {
        mockPolicyLoader.isBranchProtected.mockReturnValue(true);

        const result = await tool.execute({
          operation: 'delete',
          name: 'main'
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot delete protected branch');
      });

      it('forces deletion of unmerged branch', async () => {
        mockGitExec.exec
          .mockResolvedValueOnce({
            stdout: 'main',
            stderr: '',
            exitCode: 0,
            command: 'git symbolic-ref --short HEAD'
          })
          .mockResolvedValueOnce({
            stdout: 'main|*|origin/main\nfeature-branch||',
            stderr: '',
            exitCode: 0,
            command: 'git branch -a --format=...'
          })
          .mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
            command: 'git branch --merged'
          })
          .mockResolvedValueOnce({
            stdout: '',
            stderr: '',
            exitCode: 0,
            command: 'git branch -D feature-branch'
          });

        const result = await tool.execute({
          operation: 'delete',
          name: 'feature-branch',
          force: true
        });

        expect(result.success).toBe(true);
        expect(result.data.forced).toBe(true);
        expect(mockGitExec.exec).toHaveBeenCalledWith('branch', ['-D', 'feature-branch'], expect.any(Object));
      });
    });

    describe('list operation', () => {
      it('lists all branches', async () => {
        const result = await tool.execute({ operation: 'list' });

        expect(result.success).toBe(true);
        expect(result.data.operation).toBe('list');
        expect(result.data.branches).toHaveLength(3);
        expect(result.data.branches?.[0]).toMatchObject({
          name: 'main',
          current: true,
          remote: false
        });
        expect(result.summary).toContain('Found 3 branches');
      });
    });
  });
});
