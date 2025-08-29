/**
 * Stage Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StageTool } from '../stage.js';
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
    loadPolicy: vi.fn()
  }
}));

// Mock the parsers
const mockParseGitStatus = vi.fn();
const mockParseGitDiff = vi.fn();
vi.mocked(vi.importActual('../../git/index.js')).parseGitStatus = mockParseGitStatus;
vi.mocked(vi.importActual('../../git/index.js')).parseGitDiff = mockParseGitDiff;

describe('StageTool', () => {
  let tool: StageTool;
  const mockGitExec = vi.mocked(gitExec);
  const mockPolicyLoader = vi.mocked(policyLoader);

  beforeEach(() => {
    tool = new StageTool();
    vi.clearAllMocks();
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockPolicyLoader.loadPolicy.mockResolvedValue({
      policy: {
        safety_snapshots: {
          auto_create: true,
          trigger_operations: ['stage']
        },
        repository: {
          respect_hooks: true
        }
      },
      source: 'file',
      validation: { isValid: true, errors: [], warnings: [] },
      warnings: []
    });
    
    mockParseGitStatus.mockReturnValue({
      staged: [],
      unstaged: [
        { path: 'src/file1.ts', status: 'modified' },
        { path: 'src/file2.ts', status: 'modified' }
      ],
      untracked: ['src/file3.ts']
    });
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Stage files and hunks selectively with policy validation');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('paths');
      expect(schema.properties).toHaveProperty('hunks');
      expect(schema.properties).toHaveProperty('dry_run');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('stages specific files when paths provided', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts\nM  src/file2.ts\n?? src/file3.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git add src/file1.ts src/file2.ts'
        })
        .mockResolvedValueOnce({
          stdout: 'A  src/file1.ts\nA  src/file2.ts\n?? src/file3.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      mockParseGitStatus
        .mockReturnValueOnce({
          staged: [],
          unstaged: [
            { path: 'src/file1.ts', status: 'modified' },
            { path: 'src/file2.ts', status: 'modified' }
          ],
          untracked: ['src/file3.ts']
        })
        .mockReturnValueOnce({
          staged: [
            { path: 'src/file1.ts', status: 'added' },
            { path: 'src/file2.ts', status: 'added' }
          ],
          unstaged: [],
          untracked: ['src/file3.ts']
        });

      const result = await tool.execute({ 
        paths: ['src/file1.ts', 'src/file2.ts'] 
      });

      expect(result.success).toBe(true);
      expect(result.data.stagedCount).toBe(2);
      expect(result.data.files).toEqual(['src/file1.ts', 'src/file2.ts']);
      expect(mockGitExec.exec).toHaveBeenCalledWith('add', ['src/file1.ts', 'src/file2.ts'], expect.any(Object));
    });

    it('stages all files when no paths specified', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts\nM  src/file2.ts\n?? src/file3.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git add .'
        })
        .mockResolvedValueOnce({
          stdout: 'A  src/file1.ts\nA  src/file2.ts\nA  src/file3.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data.stagedCount).toBe(3);
      expect(mockGitExec.exec).toHaveBeenCalledWith('add', ['.'], expect.any(Object));
    });

    it('performs dry run without staging', async () => {
      mockGitExec.exec.mockResolvedValueOnce({
        stdout: 'M  src/file1.ts\nM  src/file2.ts',
        stderr: '',
        exitCode: 0,
        command: 'git status --porcelain=v1'
      });

      const result = await tool.execute({ 
        paths: ['src/file1.ts'], 
        dry_run: true 
      });

      expect(result.success).toBe(true);
      expect(result.data.stagedCount).toBe(1);
      expect(result.summary).toContain('Would stage 1 file (dry run)');
      expect(result.metadata?.dryRun).toBe(true);
      expect(mockGitExec.exec).not.toHaveBeenCalledWith('add', expect.any(Array), expect.any(Object));
    });

    it('validates file existence before staging', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockRejectedValueOnce(new Error('File not found'));

      const result = await tool.execute({ 
        paths: ['nonexistent.ts'] 
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found in repository');
    });

    it('handles interactive staging mode', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git add --interactive'
        })
        .mockResolvedValueOnce({
          stdout: 'A  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      mockParseGitStatus
        .mockReturnValueOnce({
          staged: [],
          unstaged: [{ path: 'src/file1.ts', status: 'modified' }],
          untracked: []
        })
        .mockReturnValueOnce({
          staged: [{ path: 'src/file1.ts', status: 'added' }],
          unstaged: [],
          untracked: []
        });

      const result = await tool.execute({ interactive: true });

      expect(result.success).toBe(true);
      expect(mockGitExec.exec).toHaveBeenCalledWith('add', ['--interactive', '.'], expect.any(Object));
    });

    it('handles patch mode staging', async () => {
      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git add --patch'
        })
        .mockResolvedValueOnce({
          stdout: 'A  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      const result = await tool.execute({ 
        paths: ['src/file1.ts'], 
        patch: true 
      });

      expect(result.success).toBe(true);
      expect(mockGitExec.exec).toHaveBeenCalledWith('add', ['--patch', 'src/file1.ts'], expect.any(Object));
    });

    it('stages specific hunks', async () => {
      const hunks = [
        { file: 'src/file1.ts', hunkIndex: 0 },
        { file: 'src/file1.ts', hunkIndex: 1 }
      ];

      mockGitExec.exec
        .mockResolvedValueOnce({
          stdout: 'M  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        })
        .mockResolvedValueOnce({
          stdout: 'diff --git a/src/file1.ts b/src/file1.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line',
          stderr: '',
          exitCode: 0,
          command: 'git diff src/file1.ts'
        })
        .mockResolvedValueOnce({
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git apply --cached'
        })
        .mockResolvedValueOnce({
          stdout: 'A  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      mockParseGitDiff.mockReturnValue({
        files: [{ path: 'src/file1.ts', status: 'modified', additions: 1, deletions: 1 }],
        hunks: [
          {
            file: 'src/file1.ts',
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            header: '@@ -1,3 +1,3 @@',
            lines: [
              { type: 'deletion', content: 'old line' },
              { type: 'addition', content: 'new line' }
            ]
          }
        ]
      });

      const result = await tool.execute({ hunks });

      expect(result.success).toBe(true);
      expect(result.data.files).toContain('src/file1.ts');
      expect(mockGitExec.exec).toHaveBeenCalledWith('apply', ['--cached'], expect.objectContaining({
        input: expect.stringContaining('@@ -1,3 +1,3 @@')
      }));
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
          stdout: '',
          stderr: '',
          exitCode: 0,
          command: 'git add src/file1.ts'
        })
        .mockResolvedValueOnce({
          stdout: 'A  src/file1.ts',
          stderr: '',
          exitCode: 0,
          command: 'git status --porcelain=v1'
        });

      await tool.execute({ paths: ['src/file1.ts'] });

      expect(mockGitExec.createSafetySnapshot).toHaveBeenCalledWith('stash', 'Before staging operation');
    });

    it('handles empty staging gracefully', async () => {
      mockGitExec.exec.mockResolvedValueOnce({
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

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data.stagedCount).toBe(0);
      expect(result.summary).toBe('No files staged');
    });
  });
});
