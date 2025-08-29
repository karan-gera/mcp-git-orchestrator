/**
 * Git Diff Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffTool } from '../diff.js';
import { gitExec } from '../../git/index.js';

// Mock the git executor
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

// Import the mocked parser
import { parseGitDiff } from '../../git/index.js';
const mockParseGitDiff = vi.mocked(parseGitDiff);

describe('DiffTool', () => {
  let tool: DiffTool;
  const mockGitExec = vi.mocked(gitExec);

  beforeEach(() => {
    tool = new DiffTool();
    vi.clearAllMocks();
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Get diff information for staged, unstaged, or specific files');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('scope');
      expect(schema.properties.scope.enum).toContain('staged');
      expect(schema.properties.scope.enum).toContain('unstaged');
      expect(schema.properties.scope.enum).toContain('path');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('returns error when scope is "path" but no path provided', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);

      const result = await tool.execute({ scope: 'path' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path is required when scope is "path"');
    });

    it('returns empty diff when no changes', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: '', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff' 
      });

      const result = await tool.execute({ scope: 'unstaged' });

      expect(result.success).toBe(true);
      expect(result.data.files).toEqual([]);
      expect(result.data.hunks).toEqual([]);
      expect(result.summary).toBe('No unstaged changes');
      expect(result.metadata?.isEmpty).toBe(true);
    });

    it('returns diff for unstaged changes', async () => {
      const mockDiff = {
        files: [
          {
            path: 'file1.ts',
            status: 'modified' as const,
            additions: 5,
            deletions: 2
          }
        ],
        hunks: [
          {
            file: 'file1.ts',
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 6,
            header: '@@ -1,3 +1,6 @@',
            lines: [
              { type: 'context' as const, content: 'line 1' },
              { type: 'addition' as const, content: 'new line' },
              { type: 'deletion' as const, content: 'old line' }
            ]
          }
        ]
      };

      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: 'diff --git a/file1.ts b/file1.ts\n@@ -1,3 +1,6 @@\n line 1\n+new line\n-old line', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff' 
      });
      mockParseGitDiff.mockReturnValue(mockDiff);

      const result = await tool.execute({ scope: 'unstaged' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockDiff);
      expect(result.summary).toContain('1 file changed');
      expect(result.summary).toContain('5 insertions(+)');
      expect(result.summary).toContain('2 deletions(-)');
      expect(result.metadata?.fileCount).toBe(1);
      expect(result.metadata?.totalAdditions).toBe(5);
      expect(result.metadata?.totalDeletions).toBe(2);
    });

    it('handles staged scope correctly', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: '', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff --cached' 
      });

      await tool.execute({ scope: 'staged' });

      expect(mockGitExec.exec).toHaveBeenCalledWith(
        'diff', 
        ['--no-textconv', '--cached'], 
        expect.any(Object)
      );
    });

    it('handles path scope correctly', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: '', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff -- file.ts' 
      });

      await tool.execute({ scope: 'path', path: 'file.ts' });

      expect(mockGitExec.exec).toHaveBeenCalledWith(
        'diff', 
        ['--no-textconv', '--', 'file.ts'], 
        expect.any(Object)
      );
    });

    it('handles context_lines option', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: '', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff --unified=5' 
      });

      await tool.execute({ context_lines: 5 });

      expect(mockGitExec.exec).toHaveBeenCalledWith(
        'diff', 
        ['--unified=5', '--no-textconv'], 
        expect.any(Object)
      );
    });

    it('handles name_only option', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: 'file1.ts\nfile2.ts', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff --name-only' 
      });

      const result = await tool.execute({ name_only: true });

      expect(mockGitExec.exec).toHaveBeenCalledWith(
        'diff', 
        ['--no-textconv', '--name-only'], 
        expect.any(Object)
      );
      expect(result.success).toBe(true);
      expect(result.data.files).toHaveLength(2);
      expect(result.data.files[0].path).toBe('file1.ts');
      expect(result.data.hunks).toEqual([]);
    });

    it('handles stat option', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(true);
      mockGitExec.exec.mockResolvedValue({ 
        stdout: ' file1.ts | 10 +++++++---\n file2.ts | 5 ++---', 
        stderr: '', 
        exitCode: 0, 
        command: 'git diff --stat' 
      });

      const result = await tool.execute({ stat: true });

      expect(mockGitExec.exec).toHaveBeenCalledWith(
        'diff', 
        ['--no-textconv', '--stat'], 
        expect.any(Object)
      );
      expect(result.success).toBe(true);
      expect(result.data.hunks).toEqual([]);
    });
  });
});
