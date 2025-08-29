/**
 * Commit Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommitTool } from '../commit.js';
import { gitExec } from '../../git/index.js';
import { policyLoader } from '../../policy/index.js';

// Mock dependencies
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn(),
    createSafetySnapshot: vi.fn()
  },
  parseGitStatus: vi.fn(),
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
    validateCommitMessage: vi.fn()
  }
}));

// Mock the parser
const mockParseGitStatus = vi.fn();
vi.mocked(vi.importActual('../../git/index.js')).parseGitStatus = mockParseGitStatus;

describe('CommitTool', () => {
  let tool: CommitTool;
  const mockGitExec = vi.mocked(gitExec);
  const mockPolicyLoader = vi.mocked(policyLoader);

  beforeEach(() => {
    tool = new CommitTool();
    vi.clearAllMocks();
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockPolicyLoader.loadPolicy.mockResolvedValue({
      policy: {
        commit_style: {
          enforce_conventional: true,
          allowed_types: ['feat', 'fix', 'docs', 'chore']
        },
        safety_snapshots: {
          auto_create: true,
          trigger_operations: ['commit']
        },
        repository: {
          respect_hooks: true
        }
      },
      source: 'file',
      validation: { isValid: true, errors: [], warnings: [] },
      warnings: []
    });
    
    mockPolicyLoader.validateCommitMessage.mockReturnValue({
      valid: true,
      errors: []
    });
    
    mockParseGitStatus.mockReturnValue({
      staged: [
        { path: 'src/file1.ts', status: 'modified' }
      ],
      unstaged: [],
      untracked: []
    });
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Execute Git commits with policy validation and safety checks');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('message');
      expect(schema.properties.message).toHaveProperty('minLength', 1);
      expect(schema).toHaveProperty('required', ['message']);
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({ message: 'test commit' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('validates commit message against policy', async () => {
      mockPolicyLoader.validateCommitMessage.mockReturnValue({
        valid: false,
        errors: ['Subject line too long']
      });

      const result = await tool.execute({ 
        message: 'This is a very long commit message that exceeds the maximum allowed length for the subject line'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Commit message validation failed');
      expect(result.metadata?.policyErrors).toContain('Subject line too long');
    });

    it('requires staged files for commit', async () => {
      mockParseGitStatus.mockReturnValue({
        staged: [],
        unstaged: [],
        untracked: []
      });

      const result = await tool.execute({ message: 'feat: test commit' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No staged changes to commit');
    });

    it('successfully commits with valid message and staged files', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '[main abc123d] feat: test commit\n 1 file changed, 1 insertion(+)',
          stderr: '',
          exitCode: 0,
          command: 'git commit -m "feat: test commit"'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123def456\nfeat: test commit\nJohn Doe <john@example.com>\n2023-12-07 10:30:00 +0000',
          stderr: '',
          exitCode: 0,
          command: 'git log -1 --format=%H%n%s%n%an <%ae>%n%ai'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({ message: 'feat: test commit' });

      expect(result.success).toBe(true);
      expect(result.data.sha).toBe('abc123def456');
      expect(result.data.message).toBe('feat: test commit');
      expect(result.data.author).toBe('John Doe <john@example.com>');
      expect(result.summary).toContain('Created commit abc123de');
    });

    it('performs dry run without committing', async () => {
      const result = await tool.execute({ 
        message: 'feat: test commit', 
        dry_run: true 
      });

      expect(result.success).toBe(true);
      expect(result.data.sha).toBe('dry-run-sha');
      expect(result.summary).toContain('Would commit with message');
      expect(result.metadata?.dryRun).toBe(true);
      expect(mockGitExec.exec).not.toHaveBeenCalledWith('commit', expect.any(Array), expect.any(Object));
    });

    it('includes all files when include_all is true', async () => {
      mockParseGitStatus.mockReturnValue({
        staged: [],
        unstaged: [
          { path: 'src/file1.ts', status: 'modified' },
          { path: 'src/file2.ts', status: 'modified' }
        ],
        untracked: []
      });

      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts\nM  src/file2.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git add -A'
        })
        .mockResolvedValueOnce({
          stdout: '[main abc123d] feat: test commit\n 2 files changed, 2 insertions(+)',
          stderr: '',
          exitCode: 0,
          command: 'git commit -m "feat: test commit"'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123def456\nfeat: test commit\nJohn Doe <john@example.com>\n2023-12-07 10:30:00 +0000',
          stderr: '',
          exitCode: 0,
          command: 'git log -1 --format=%H%n%s%n%an <%ae>%n%ai'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({ 
        message: 'feat: test commit', 
        include_all: true 
      });

      expect(result.success).toBe(true);
      expect(mockGitExec.exec).toHaveBeenCalledWith('add', ['-A'], expect.any(Object));
    });

    it('handles amend option', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '[main abc123d] feat: amended commit\n 1 file changed, 1 insertion(+)',
          stderr: '',
          exitCode: 0,
          command: 'git commit -m "feat: amended commit" --amend'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123def456\nfeat: amended commit\nJohn Doe <john@example.com>\n2023-12-07 10:30:00 +0000',
          stderr: '',
          exitCode: 0,
          command: 'git log -1 --format=%H%n%s%n%an <%ae>%n%ai'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({ 
        message: 'feat: amended commit', 
        amend: true 
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Amended commit');
      expect(mockGitExec.exec).toHaveBeenCalledWith('commit', ['-m', 'feat: amended commit', '--amend'], expect.any(Object));
    });

    it('handles GPG signing', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '[main abc123d] feat: signed commit\n 1 file changed, 1 insertion(+)',
          stderr: '',
          exitCode: 0,
          command: 'git commit -m "feat: signed commit" -S'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123def456\nfeat: signed commit\nJohn Doe <john@example.com>\n2023-12-07 10:30:00 +0000',
          stderr: '',
          exitCode: 0,
          command: 'git log -1 --format=%H%n%s%n%an <%ae>%n%ai'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({ 
        message: 'feat: signed commit', 
        sign: true 
      });

      expect(result.success).toBe(true);
      expect(mockGitExec.exec).toHaveBeenCalledWith('commit', ['-m', 'feat: signed commit', '-S'], expect.any(Object));
    });

    it('skips hooks when noVerify is true', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '[main abc123d] feat: no verify commit\n 1 file changed, 1 insertion(+)',
          stderr: '',
          exitCode: 0,
          command: 'git commit -m "feat: no verify commit" --no-verify'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123def456\nfeat: no verify commit\nJohn Doe <john@example.com>\n2023-12-07 10:30:00 +0000',
          stderr: '',
          exitCode: 0,
          command: 'git log -1 --format=%H%n%s%n%an <%ae>%n%ai'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({ 
        message: 'feat: no verify commit', 
        noVerify: true 
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('(hooks skipped)');
      expect(mockGitExec.exec).toHaveBeenCalledWith('commit', ['-m', 'feat: no verify commit', '--no-verify'], expect.any(Object));
    });

    it('blocks commit with unmerged files', async () => {
      mockParseGitStatus.mockReturnValue({
        staged: [
          { path: 'src/file1.ts', status: 'unmerged' }
        ],
        unstaged: [],
        untracked: []
      });

      const result = await tool.execute({ message: 'feat: test commit' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot commit with unmerged files');
    });

    it('creates safety snapshot when configured', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '[main abc123d] feat: test commit\n 1 file changed, 1 insertion(+)',
          stderr: '',
          exitCode: 0,
          command: 'git commit -m "feat: test commit"'
        })
        .mockResolvedValueOnce({
          stdout: 'abc123def456\nfeat: test commit\nJohn Doe <john@example.com>\n2023-12-07 10:30:00 +0000',
          stderr: '',
          exitCode: 0,
          command: 'git log -1 --format=%H%n%s%n%an <%ae>%n%ai'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      await tool.execute({ message: 'feat: test commit' });

      expect(mockGitExec.createSafetySnapshot).toHaveBeenCalledWith('stash', 'Before commit operation');
    });
  });
});
