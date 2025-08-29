/**
 * Push Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushTool } from '../push.js';
import { gitExec } from '../../git/index.js';
import { policyLoader } from '../../policy/index.js';

// Mock dependencies
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn(),
    createSafetySnapshot: vi.fn()
  },
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
    isBranchProtected: vi.fn(),
    getPrepushChecks: vi.fn()
  }
}));

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

describe('PushTool', () => {
  let tool: PushTool;
  const mockGitExec = vi.mocked(gitExec);
  const mockPolicyLoader = vi.mocked(policyLoader);

  beforeEach(() => {
    tool = new PushTool();
    vi.clearAllMocks();
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockPolicyLoader.loadPolicy.mockResolvedValue({
      policy: {
        protected_branches: ['main', 'master', 'production'],
        safety_snapshots: {
          auto_create: true,
          trigger_operations: ['push']
        }
      },
      source: 'file',
      validation: { isValid: true, errors: [], warnings: [] },
      warnings: []
    });
    mockPolicyLoader.isBranchProtected.mockReturnValue(false);
    mockPolicyLoader.getPrepushChecks.mockReturnValue([]);
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Execute Git push operations with protected branch enforcement and pre-push checks');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('remote');
      expect(schema.properties).toHaveProperty('danger_mode');
      expect(schema.properties).toHaveProperty('confirm');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('blocks push to protected branch without danger mode', async () => {
      mockGitExec.exec.mockResolvedValue({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
        command: 'git symbolic-ref --short HEAD'
      });
      mockPolicyLoader.isBranchProtected.mockReturnValue(true);

      const result = await tool.execute({ branch: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('protected');
      expect(result.metadata?.dangerModeRequired).toBe(true);
    });

    it('requires confirmation for protected branch push in danger mode', async () => {
      mockGitExec.exec.mockResolvedValue({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
        command: 'git symbolic-ref --short HEAD'
      });
      mockPolicyLoader.isBranchProtected.mockReturnValue(true);

      const result = await tool.execute({ 
        branch: 'main', 
        danger_mode: true 
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
      expect(result.metadata?.confirmationRequired).toBe(true);
    });

    it('validates confirmation string for protected branch', async () => {
      mockGitExec.exec.mockResolvedValue({
        stdout: 'main',
        stderr: '',
        exitCode: 0,
        command: 'git symbolic-ref --short HEAD'
      });
      mockPolicyLoader.isBranchProtected.mockReturnValue(true);

      const result = await tool.execute({ 
        branch: 'main', 
        danger_mode: true,
        confirm: 'wrong confirmation'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid confirmation');
    });

    it('allows protected branch push with correct confirmation', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'main',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123 Initial commit',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/main..HEAD --oneline'
        })
        .mockResolvedValueOnce({
          stdout: 'To origin\n   abc123..def456  main -> main',
          stderr: '',
          exitCode: 0,
          command: 'git push origin main'
        });

      mockPolicyLoader.isBranchProtected.mockReturnValue(true);

      const result = await tool.execute({ 
        branch: 'main', 
        danger_mode: true,
        confirm: 'DANGER: Push to protected branch main'
      });

      expect(result.success).toBe(true);
      expect(result.data.outcome).toBe('success');
      expect(result.metadata?.dangerMode).toBe(true);
    });

    it('runs pre-push checks before pushing', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123 New feature',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/feature-branch..HEAD --oneline'
        });

      const mockChecks = [
        { name: 'lint', command: 'npm run lint', required: true, timeout: 60 },
        { name: 'test', command: 'npm test', required: false, timeout: 300 }
      ];
      mockPolicyLoader.getPrepushChecks.mockReturnValue(mockChecks);

      // Mock spawn for check execution
      const { spawn } = await import('child_process');
      const mockSpawn = vi.mocked(spawn);
      mockSpawn.mockImplementation((command, args, options) => {
        const mockChild = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn()
        };
        
        // Simulate successful check
        setTimeout(() => {
          const onStdout = mockChild.stdout.on.mock.calls.find(call => call[0] === 'data')?.[1];
          if (onStdout) onStdout('Check passed');
          
          const onClose = mockChild.on.mock.calls.find(call => call[0] === 'close')?.[1];
          if (onClose) onClose(0);
        }, 10);
        
        return mockChild as any;
      });

      const result = await tool.execute({ branch: 'feature-branch' });

      expect(mockSpawn).toHaveBeenCalledTimes(2); // Two checks
      expect(result.metadata?.checkResults).toHaveLength(2);
    });

    it('fails when required pre-push checks fail', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123 New feature',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/feature-branch..HEAD --oneline'
        });

      const mockChecks = [
        { name: 'lint', command: 'npm run lint', required: true, timeout: 60 }
      ];
      mockPolicyLoader.getPrepushChecks.mockReturnValue(mockChecks);

      // Mock failing check
      const { spawn } = await import('child_process');
      const mockSpawn = vi.mocked(spawn);
      mockSpawn.mockImplementation(() => {
        const mockChild = {
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn()
        };
        
        setTimeout(() => {
          const onStderr = mockChild.stderr.on.mock.calls.find(call => call[0] === 'data')?.[1];
          if (onStderr) onStderr('Lint errors found');
          
          const onClose = mockChild.on.mock.calls.find(call => call[0] === 'close')?.[1];
          if (onClose) onClose(1);
        }, 10);
        
        return mockChild as any;
      });

      const result = await tool.execute({ branch: 'feature-branch' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Required pre-push checks failed');
    });

    it('skips checks when skip_checks is true', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123 New feature',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/feature-branch..HEAD --oneline'
        })
        .mockResolvedValueOnce({
          stdout: 'To origin\n   abc123..def456  feature-branch -> feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git push origin feature-branch'
        });

      const result = await tool.execute({ 
        branch: 'feature-branch', 
        skip_checks: true 
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.checkResults).toEqual([]);
    });

    it('handles up-to-date branch', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'main',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/main..HEAD --oneline'
        });

      const result = await tool.execute({ branch: 'main' });

      expect(result.success).toBe(true);
      expect(result.data.outcome).toBe('up-to-date');
      expect(result.summary).toContain('up-to-date');
    });

    it('performs dry run without pushing', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123 New feature\ndef456 Another commit',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/feature-branch..HEAD --oneline'
        });

      const result = await tool.execute({ 
        branch: 'feature-branch', 
        dry_run: true 
      });

      expect(result.success).toBe(true);
      expect(result.data.outcome).toBe('success');
      expect(result.summary).toContain('Would push 2 commits (dry run)');
      expect(result.metadata?.dryRun).toBe(true);
    });

    it('creates safety snapshot when configured', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git symbolic-ref --short HEAD'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123 New feature',
          stderr: '',
          exitCode: 0,
          command: 'git log origin/feature-branch..HEAD --oneline'
        })
        .mockResolvedValueOnce({
          stdout: 'To origin\n   abc123..def456  feature-branch -> feature-branch',
          stderr: '',
          exitCode: 0,
          command: 'git push origin feature-branch'
        });

      await tool.execute({ branch: 'feature-branch' });

      expect(mockGitExec.createSafetySnapshot).toHaveBeenCalledWith('stash', 'Before push operation');
    });
  });
});
