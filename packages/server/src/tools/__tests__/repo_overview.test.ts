/**
 * Repository Overview Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepoOverviewTool } from '../repo_overview.js';
import { gitExec } from '../../git/index.js';

// Mock the git executor
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn(),
    getRepositoryRoot: vi.fn()
  },
  parseGitBranches: vi.fn(),
  parseGitRemotes: vi.fn(),
  parseAheadBehind: vi.fn(),
  GitError: class GitError extends Error {
    constructor(code: number, message: string, stderr: string, command: string) {
      super(message);
      this.name = 'GitError';
    }
  }
}));

// Import and mock the parsers
import { parseGitBranches, parseGitRemotes, parseAheadBehind } from '../../git/index.js';
const mockParseGitBranches = vi.mocked(parseGitBranches);
const mockParseGitRemotes = vi.mocked(parseGitRemotes);
const mockParseAheadBehind = vi.mocked(parseAheadBehind);

describe('RepoOverviewTool', () => {
  let tool: RepoOverviewTool;
  const mockGitExec = vi.mocked(gitExec);

  beforeEach(() => {
    tool = new RepoOverviewTool();
    vi.clearAllMocks();
    
    // Setup default mock returns
    mockParseGitRemotes.mockReturnValue([]);
    mockParseAheadBehind.mockReturnValue({ ahead: 0, behind: 0 });
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Get repository overview with branch, head, and remote information');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('include_branches');
      expect(schema.properties).toHaveProperty('include_remotes');
      expect(schema.properties).toHaveProperty('include_tracking');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('returns basic overview for valid repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: '/repo/path', stderr: '', exitCode: 0, command: 'git rev-parse --show-toplevel' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git symbolic-ref --short HEAD' })
        .mockResolvedValueOnce({ stdout: 'abc123def456', stderr: '', exitCode: 0, command: 'git rev-parse HEAD' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git remote -v' })
        .mockResolvedValueOnce({ stdout: '## main', stderr: '', exitCode: 0, command: 'git status -b --porcelain=v1' });

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('root', '/repo/path');
      expect(result.data).toHaveProperty('branch', 'main');
      expect(result.data).toHaveProperty('head', 'abc123def456');
      expect(result.data).toHaveProperty('remotes');
      expect(result.data).toHaveProperty('aheadBehind');
      expect(result.summary).toContain('Repository on branch \'main\'');
    });

    it('handles detached HEAD state', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: '/repo/path', stderr: '', exitCode: 0, command: 'git rev-parse --show-toplevel' })
        .mockRejectedValueOnce(new Error('fatal: ref HEAD is not a symbolic ref'))
        .mockResolvedValueOnce({ stdout: 'abc123d', stderr: '', exitCode: 0, command: 'git rev-parse --short HEAD' })
        .mockResolvedValueOnce({ stdout: 'abc123def456', stderr: '', exitCode: 0, command: 'git rev-parse HEAD' })
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0, command: 'git remote -v' });

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data.branch).toBe('detached@abc123d');
      expect(result.summary).toContain('detached HEAD state');
    });

    it('parses remotes when available', async () => {
      const mockRemoteOutput = 'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)';
      
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: '/repo/path', stderr: '', exitCode: 0, command: 'git rev-parse --show-toplevel' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git symbolic-ref --short HEAD' })
        .mockResolvedValueOnce({ stdout: 'abc123def456', stderr: '', exitCode: 0, command: 'git rev-parse HEAD' })
        .mockResolvedValueOnce({ stdout: mockRemoteOutput, stderr: '', exitCode: 0, command: 'git remote -v' })
        .mockResolvedValueOnce({ stdout: '## main', stderr: '', exitCode: 0, command: 'git status -b --porcelain=v1' });

      mockParseGitRemotes.mockReturnValue([
        { name: 'origin', url: 'https://github.com/user/repo.git', type: 'fetch' }
      ]);

      const result = await tool.execute({ include_remotes: true });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('with 1 remote');
    });

    it('handles options correctly', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec
        .mockResolvedValueOnce({ stdout: '/repo/path', stderr: '', exitCode: 0, command: 'git rev-parse --show-toplevel' })
        .mockResolvedValueOnce({ stdout: 'main', stderr: '', exitCode: 0, command: 'git symbolic-ref --short HEAD' })
        .mockResolvedValueOnce({ stdout: 'abc123def456', stderr: '', exitCode: 0, command: 'git rev-parse HEAD' });

      const result = await tool.execute({ 
        include_remotes: false, 
        include_tracking: false 
      });

      expect(result.success).toBe(true);
      expect(result.data.remotes).toEqual([]);
      expect(result.data.aheadBehind).toEqual({ ahead: 0, behind: 0 });
    });
  });
});
