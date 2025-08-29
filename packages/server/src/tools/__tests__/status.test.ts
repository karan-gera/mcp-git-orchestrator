/**
 * Git Status Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusTool } from '../status.js';
import { gitExec } from '../../git/index.js';

// Mock the git executor
vi.mock('../../git/index.js', () => ({
  gitExec: {
    isValidRepository: vi.fn(),
    exec: vi.fn()
  },
  parseGitStatus: vi.fn(),
  GitError: class GitError extends Error {
    constructor(code: number, message: string, stderr: string, command: string) {
      super(message);
      this.name = 'GitError';
    }
  }
}));

// Mock the parser
const mockParseGitStatus = vi.fn();
vi.mocked(vi.importActual('../../git/index.js')).parseGitStatus = mockParseGitStatus;

describe('StatusTool', () => {
  let tool: StatusTool;
  const mockGitExec = vi.mocked(gitExec);

  beforeEach(() => {
    tool = new StatusTool();
    vi.clearAllMocks();
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Get Git status showing staged, unstaged, and untracked files');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('include_untracked');
      expect(schema.properties).toHaveProperty('summary_only');
      expect(schema.properties).toHaveProperty('include_paths');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('returns clean status when no changes', async () => {
      const mockStatus = {
        staged: [],
        unstaged: [],
        untracked: []
      };

      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: '', 
        stderr: '', 
        exitCode: 0, 
        command: 'git status --porcelain=v1 -u' 
      });
      mockParseGitStatus.mockReturnValue(mockStatus);

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockStatus);
      expect(result.summary).toBe('Working tree clean');
      expect(result.metadata?.isClean).toBe(true);
    });

    it('returns status with changes', async () => {
      const mockStatus = {
        staged: [
          { path: 'file1.ts', status: 'modified' },
          { path: 'file2.ts', status: 'added' }
        ],
        unstaged: [
          { path: 'file3.ts', status: 'modified' }
        ],
        untracked: ['file4.ts']
      };

      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: 'M  file1.ts\nA  file2.ts\n M file3.ts\n?? file4.ts', 
        stderr: '', 
        exitCode: 0, 
        command: 'git status --porcelain=v1 -u' 
      });
      mockParseGitStatus.mockReturnValue(mockStatus);

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockStatus);
      expect(result.summary).toContain('2 staged files');
      expect(result.summary).toContain('1 unstaged file');
      expect(result.summary).toContain('1 untracked file');
      expect(result.metadata?.isClean).toBe(false);
      expect(result.metadata?.totalChanges).toBe(4);
    });

    it('handles include_untracked option', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: '', 
        stderr: '', 
        exitCode: 0, 
        command: 'git status --porcelain=v1' 
      });
      mockParseGitStatus.mockReturnValue({
        staged: [],
        unstaged: [],
        untracked: []
      });

      await tool.execute({ include_untracked: false });

      expect(mockGitExec.exec).toHaveBeenCalledWith('status', ['--porcelain=v1'], expect.any(Object));
    });

    it('handles summary_only option', async () => {
      const mockStatus = {
        staged: [{ path: 'file1.ts', status: 'modified' }],
        unstaged: [],
        untracked: []
      };

      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: 'M  file1.ts', 
        stderr: '', 
        exitCode: 0, 
        command: 'git status --porcelain=v1 -u' 
      });
      mockParseGitStatus.mockReturnValue(mockStatus);

      const result = await tool.execute({ summary_only: true });

      expect(result.success).toBe(true);
      expect(result.data.staged).toEqual([]);
      expect(result.data.unstaged).toEqual([]);
      expect(result.data.untracked).toEqual([]);
      expect(result.summary).toContain('1 modified file staged');
    });

    it('handles include_paths option', async () => {
      const mockStatus = {
        staged: [{ path: 'file1.ts', status: 'modified' }],
        unstaged: [],
        untracked: ['file2.ts']
      };

      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: 'M  file1.ts\n?? file2.ts', 
        stderr: '', 
        exitCode: 0, 
        command: 'git status --porcelain=v1 -u' 
      });
      mockParseGitStatus.mockReturnValue(mockStatus);

      const result = await tool.execute({ include_paths: false });

      expect(result.success).toBe(true);
      expect(result.data.staged[0].path).toBe('***');
      expect(result.data.untracked[0]).toBe('***');
    });
  });
});
