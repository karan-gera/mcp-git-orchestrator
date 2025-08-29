/**
 * Dry Run Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DryRunTool } from '../dry_run.js';
import { gitExec } from '../../git/index.js';
import { writeFile, mkdir, rm, access } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { GitPlanStep } from '../../types.js';

// Mock dependencies
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn()
  },
  GitError: class GitError extends Error {
    constructor(code: number, message: string, stderr: string, command: string) {
      super(message);
      this.name = 'GitError';
    }
  }
}));

describe('DryRunTool', () => {
  let tool: DryRunTool;
  let tempRepo: string;
  let mockWorktreePath: string;
  const mockGitExec = vi.mocked(gitExec);

  beforeEach(async () => {
    tool = new DryRunTool();
    vi.clearAllMocks();
    
    // Create temporary repository for testing
    tempRepo = join(tmpdir(), `dry-run-test-${Date.now()}`);
    await mkdir(tempRepo, { recursive: true });
    
    // Setup mock worktree path
    mockWorktreePath = join(tempRepo, 'mcp-dry-run-test');
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Execute a plan of Git operations in isolation using temporary worktree for safe validation');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('plan');
      expect(schema.properties.plan).toHaveProperty('type', 'array');
      expect(schema.properties.plan.items.properties.operation).toHaveProperty('enum');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({ plan: [] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('returns error for empty plan', async () => {
      const result = await tool.execute({ plan: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid plan: Plan cannot be empty');
    });

    it('validates plan operations', async () => {
      const invalidPlan: GitPlanStep[] = [
        { operation: 'invalid_op' as any, args: {} }
      ];

      const result = await tool.execute({ plan: invalidPlan });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid operation \'invalid_op\'');
    });

    it('validates plan dependencies', async () => {
      const invalidPlan: GitPlanStep[] = [
        { operation: 'stage', args: {}, dependencies: [1] }, // Depends on future step
        { operation: 'commit', args: { message: 'test' } }
      ];

      const result = await tool.execute({ plan: invalidPlan });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Dependency 1 must be a previous step');
    });

    it('validates required arguments for operations', async () => {
      const invalidPlan: GitPlanStep[] = [
        { operation: 'commit', args: {} } // Missing required message
      ];

      const result = await tool.execute({ plan: invalidPlan });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Commit operation requires \'message\' argument');
    });

    it('executes simple plan successfully', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['file.txt'] } },
        { operation: 'commit', args: { message: 'Test commit' } }
      ];

      // Mock Git operations
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Current branch
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' }) // Create worktree
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' }) // Initial state
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Initial state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' }) // Initial state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git add file.txt' }) // Stage operation
        .mockResolvedValueOnce({ stdout: 'M file.txt', stderr: '', exitCode: 0, command: 'git status --porcelain' }) // Final state
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Final state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' }) // Final state
        .mockResolvedValueOnce({ stdout: 'M file.txt', stderr: '', exitCode: 0, command: 'git status --porcelain' }) // Initial state
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Initial state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' }) // Initial state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git commit -m "Test commit"' }) // Commit operation
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' }) // Final state
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Final state
        .mockResolvedValueOnce({ stdout: 'abc123 Test commit', stderr: '', exitCode: 0, command: 'git log --oneline -5' }) // Final state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' }); // Cleanup

      const result = await tool.execute({ plan }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.planValid).toBe(true);
      expect(result.data.transcript).toHaveLength(2);
      expect(result.data.transcript[0].status).toBe('success');
      expect(result.data.transcript[1].status).toBe('success');
      expect(result.data.summary.successfulSteps).toBe(2);
      expect(result.data.summary.failedSteps).toBe(0);
    });

    it('handles step failures with fail_fast', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['nonexistent.txt'] } },
        { operation: 'commit', args: { message: 'Should not execute' } }
      ];

      // Mock Git operations - stage fails
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Current branch
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' }) // Create worktree
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' }) // Initial state
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' }) // Initial state
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' }) // Initial state
        .mockRejectedValueOnce(new Error('File not found')) // Stage operation fails
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' }); // Cleanup

      const result = await tool.execute({ plan, fail_fast: true }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.transcript).toHaveLength(1); // Second step not executed
      expect(result.data.transcript[0].status).toBe('failure');
      expect(result.data.summary.successfulSteps).toBe(0);
      expect(result.data.summary.failedSteps).toBe(1);
    });

    it('continues execution when fail_fast is disabled', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['nonexistent.txt'] } },
        { operation: 'stage', args: { paths: ['existing.txt'] } }
      ];

      // Mock Git operations - first stage fails, second succeeds
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockRejectedValueOnce(new Error('File not found')) // First stage fails
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git add existing.txt' }) // Second stage succeeds
        .mockResolvedValueOnce({ stdout: 'M existing.txt', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan, fail_fast: false }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.transcript).toHaveLength(2);
      expect(result.data.transcript[0].status).toBe('failure');
      expect(result.data.transcript[1].status).toBe('success');
      expect(result.data.summary.successfulSteps).toBe(1);
      expect(result.data.summary.failedSteps).toBe(1);
    });

    it('handles step dependencies correctly', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['file.txt'] } },
        { operation: 'commit', args: { message: 'Test commit' }, dependencies: [0] }
      ];

      // Mock successful execution
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git add file.txt' })
        .mockResolvedValueOnce({ stdout: 'M file.txt', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: 'M file.txt', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git commit -m "Test commit"' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: 'abc123 Test commit', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.transcript[1].status).toBe('success');
    });

    it('skips steps when dependencies fail', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['nonexistent.txt'] } },
        { operation: 'commit', args: { message: 'Should be skipped' }, dependencies: [0] }
      ];

      // Mock first stage failing
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockRejectedValueOnce(new Error('File not found'))
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan, fail_fast: false }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.transcript).toHaveLength(2);
      expect(result.data.transcript[0].status).toBe('failure');
      expect(result.data.transcript[1].status).toBe('skipped');
      expect(result.data.summary.skippedSteps).toBe(1);
    });

    it('simulates push operations safely', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'push', args: { remote: 'origin', branch: 'main' } }
      ];

      // Mock push simulation
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: 'Everything up-to-date', stderr: '', exitCode: 0, command: 'git push --dry-run origin main' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.transcript[0].status).toBe('warning'); // Push should have warnings
      expect(result.data.transcript[0].warnings).toContain('Push operation simulated - no actual push performed');
    });

    it('calculates risk levels correctly', async () => {
      const safePlan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['file.txt'] } }
      ];

      // Mock successful execution
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git add file.txt' })
        .mockResolvedValueOnce({ stdout: 'M file.txt', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan: safePlan }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.summary.riskLevel).toBe('low');
      expect(result.data.summary.recommendedActions).toContain('Plan appears safe to execute');
    });

    it('generates rollback instructions', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'commit', args: { message: 'Test commit' } }
      ];

      // Mock successful commit
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git commit -m "Test commit"' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: 'abc123 Test commit', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.rollbackInstructions).toBeDefined();
      expect(result.data.rollbackInstructions).toContain('git reset HEAD~1  # Undo commit from step 0');
    });

    it('handles timeout correctly', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'stage', args: { paths: ['file.txt'] } }
      ];

      // Mock slow operation
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 2000))); // Slow operation

      const result = await tool.execute({ 
        plan, 
        timeout: 1 // 1 second timeout
      }, { repositoryPath: tempRepo });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Execution timeout after 1s');
    });

    it('supports branch operations', async () => {
      const plan: GitPlanStep[] = [
        { operation: 'branch', args: { op: 'create', name: 'feature-branch' } }
      ];

      // Mock branch creation
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree add' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git branch feature-branch HEAD' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git status --porcelain' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git branch --show-current' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git log --oneline -5' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git worktree remove' });

      const result = await tool.execute({ plan }, { repositoryPath: tempRepo });

      expect(result.success).toBe(true);
      expect(result.data.transcript[0].output).toContain('Created branch: feature-branch');
    });
  });

  describe('plan validation', () => {
    it('validates commit operations require message', () => {
      const plan: GitPlanStep[] = [
        { operation: 'commit', args: {} }
      ];

      // Should be caught by validation
      expect(async () => {
        await tool.execute({ plan });
      }).not.toThrow();
    });

    it('validates branch operations require name or op', () => {
      const plan: GitPlanStep[] = [
        { operation: 'branch', args: {} }
      ];

      // Should be caught by validation
      expect(async () => {
        await tool.execute({ plan });
      }).not.toThrow();
    });

    it('validates merge operations require target', () => {
      const plan: GitPlanStep[] = [
        { operation: 'merge', args: {} }
      ];

      // Should be caught by validation
      expect(async () => {
        await tool.execute({ plan });
      }).not.toThrow();
    });
  });
});
