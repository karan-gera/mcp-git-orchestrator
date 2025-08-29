/**
 * Propose Commit Tool Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProposeCommitTool } from '../propose_commit.js';
import { gitExec } from '../../git/index.js';
import { policyLoader } from '../../policy/index.js';
import { readFile } from 'fs/promises';

// Mock dependencies
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

vi.mock('../../policy/index.js', () => ({
  policyLoader: {
    loadPolicy: vi.fn(),
    validateCommitMessage: vi.fn()
  }
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn()
}));

// Mock the parser
const mockParseGitStatus = vi.fn();
vi.mocked(vi.importActual('../../git/index.js')).parseGitStatus = mockParseGitStatus;

describe('ProposeCommitTool', () => {
  let tool: ProposeCommitTool;
  const mockGitExec = vi.mocked(gitExec);
  const mockPolicyLoader = vi.mocked(policyLoader);
  const mockReadFile = vi.mocked(readFile);

  beforeEach(() => {
    tool = new ProposeCommitTool();
    vi.clearAllMocks();
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockPolicyLoader.loadPolicy.mockResolvedValue({
      policy: {
        commit_style: {
          require_body_for: ['feat', 'fix'],
          enforce_conventional: true,
          allowed_types: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore']
        }
      },
      source: 'defaults',
      validation: { isValid: true, errors: [], warnings: [] },
      warnings: []
    });
    mockPolicyLoader.validateCommitMessage.mockReturnValue({
      valid: true,
      errors: []
    });
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Generate conventional commit messages based on changed files with intelligent scope detection');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('changed_files');
      expect(schema.properties).toHaveProperty('include_analysis');
      expect(schema.properties).toHaveProperty('force_type');
      expect(schema.properties).toHaveProperty('force_scope');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('returns error when no staged files and no changed_files provided', async () => {
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

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No staged files found');
    });

    it('generates commit message for feature files', async () => {
      const mockStatus = {
        staged: [
          { path: 'packages/server/src/features/auth.ts', status: 'added' },
          { path: 'packages/server/src/features/user.ts', status: 'modified' }
        ],
        unstaged: [],
        untracked: []
      };

      mockGitExec.exec.mockResolvedValue({
        stdout: 'A  packages/server/src/features/auth.ts\nM  packages/server/src/features/user.ts',
        stderr: '',
        exitCode: 0,
        command: 'git status --porcelain=v1'
      });
      mockParseGitStatus.mockReturnValue(mockStatus);

      // Mock package.json reading
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('packages/server/package.json')) {
          return JSON.stringify({ name: '@mcp-git-orchestrator/server' });
        }
        throw new Error('File not found');
      });

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^feat\(server\):/);
      expect(result.summary).toContain('Proposed:');
      expect(result.metadata?.fileCount).toBe(2);
    });

    it('detects test files correctly', async () => {
      const changedFiles = [
        'packages/server/src/auth/__tests__/auth.test.ts',
        'packages/server/src/user/user.spec.ts'
      ];

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^test\(server\):/);
    });

    it('detects documentation files correctly', async () => {
      const changedFiles = [
        'README.md',
        'docs/api.md',
        'packages/server/CHANGELOG.md'
      ];

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^docs:/);
    });

    it('detects configuration files correctly', async () => {
      const changedFiles = [
        'package.json',
        'tsconfig.json',
        '.gitignore'
      ];

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^chore:/);
    });

    it('groups files by package scope', async () => {
      const changedFiles = [
        'packages/server/src/auth.ts',
        'packages/cli/src/commands.ts'
      ];

      // Mock package.json files
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('packages/server/package.json')) {
          return JSON.stringify({ name: '@mcp-git-orchestrator/server' });
        }
        if (path.includes('packages/cli/package.json')) {
          return JSON.stringify({ name: '@mcp-git-orchestrator/cli' });
        }
        throw new Error('File not found');
      });

      const result = await tool.execute({ 
        changed_files: changedFiles,
        include_analysis: true 
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.analysis).toBeDefined();
      expect(result.metadata?.analysis.groups).toHaveLength(2);
    });

    it('respects force_type parameter', async () => {
      const changedFiles = ['src/feature.ts'];

      const result = await tool.execute({ 
        changed_files: changedFiles,
        force_type: 'fix'
      });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^fix:/);
    });

    it('respects force_scope parameter', async () => {
      const changedFiles = ['src/feature.ts'];

      const result = await tool.execute({ 
        changed_files: changedFiles,
        force_scope: 'custom'
      });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^feat\(custom\):/);
    });

    it('adds prefix when provided', async () => {
      const changedFiles = ['src/feature.ts'];

      const result = await tool.execute({ 
        changed_files: changedFiles,
        prefix: 'WIP'
      });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^WIP feat:/);
    });

    it('generates body for required commit types', async () => {
      const changedFiles = ['src/feature.ts', 'src/utils.ts'];

      const result = await tool.execute({ 
        changed_files: changedFiles,
        force_type: 'feat'
      });

      expect(result.success).toBe(true);
      expect(result.data.body).toBeDefined();
      expect(result.data.body).toContain('Changes include:');
    });

    it('handles CODEOWNERS for trailers', async () => {
      const changedFiles = ['src/critical-feature.ts'];

      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('.github/CODEOWNERS')) {
          return 'src/critical-feature.ts @team-lead @security-team\n* @default-reviewer';
        }
        throw new Error('File not found');
      });

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.trailers).toEqual([
        { key: 'Reviewed-by', value: '@team-lead, @security-team' }
      ]);
    });

    it('validates commit message against policy', async () => {
      const changedFiles = ['src/feature.ts'];

      mockPolicyLoader.validateCommitMessage.mockReturnValue({
        valid: false,
        errors: ['Subject line too long']
      });

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.metadata?.warnings).toContain('Subject line too long');
      expect(result.summary).toContain('Policy validation failed');
    });

    it('handles mixed file types intelligently', async () => {
      const changedFiles = [
        'src/auth.ts',           // feat
        'src/auth.test.ts',      // test
        'README.md',             // docs
        'package.json'           // chore
      ];

      const result = await tool.execute({ 
        changed_files: changedFiles,
        include_analysis: true 
      });

      expect(result.success).toBe(true);
      expect(result.metadata?.analysis.groups.length).toBeGreaterThan(1);
      
      // Should pick the most significant group (likely feat for src files)
      expect(result.data.subject).toMatch(/^(feat|test|docs|chore):/);
    });
  });

  describe('scope detection', () => {
    it('detects package-based scopes', async () => {
      const changedFiles = ['packages/server/src/index.ts'];
      
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('packages/server/package.json')) {
          return JSON.stringify({ name: '@mcp-git-orchestrator/server' });
        }
        throw new Error('File not found');
      });

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/\(server\)/);
    });

    it('falls back to directory-based scopes', async () => {
      const changedFiles = ['frontend/components/Button.tsx'];
      
      mockReadFile.mockRejectedValue(new Error('No package.json'));

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/\(frontend\)/);
    });

    it('uses root scope for top-level files', async () => {
      const changedFiles = ['README.md'];
      
      mockReadFile.mockRejectedValue(new Error('No package.json'));

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).not.toMatch(/\([^)]+\)/); // No scope in parentheses
    });
  });

  describe('type detection heuristics', () => {
    const testCases = [
      { files: ['src/auth.ts'], expectedType: 'feat' },
      { files: ['src/auth.test.ts'], expectedType: 'test' },
      { files: ['src/auth.spec.ts'], expectedType: 'test' },
      { files: ['README.md'], expectedType: 'docs' },
      { files: ['docs/api.md'], expectedType: 'docs' },
      { files: ['package.json'], expectedType: 'chore' },
      { files: ['tsconfig.json'], expectedType: 'chore' },
      { files: ['.github/workflows/ci.yml'], expectedType: 'ci' },
      { files: ['webpack.config.js'], expectedType: 'build' },
      { files: ['src/styles.css'], expectedType: 'style' },
      { files: ['src/perf/benchmark.ts'], expectedType: 'perf' },
      { files: ['src/bugfix/auth.ts'], expectedType: 'fix' },
      { files: ['src/fix/validation.ts'], expectedType: 'fix' }
    ];

    testCases.forEach(({ files, expectedType }) => {
      it(`detects ${expectedType} for ${files[0]}`, async () => {
        const result = await tool.execute({ changed_files: files });
        
        expect(result.success).toBe(true);
        expect(result.data.subject).toMatch(new RegExp(`^${expectedType}`));
      });
    });
  });

  describe('commit message quality', () => {
    it('generates descriptive commit messages', async () => {
      const changedFiles = ['packages/server/src/auth/login.ts'];
      
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('packages/server/package.json')) {
          return JSON.stringify({ name: '@mcp-git-orchestrator/server' });
        }
        throw new Error('File not found');
      });

      const result = await tool.execute({ changed_files: changedFiles });

      expect(result.success).toBe(true);
      expect(result.data.subject).toMatch(/^feat\(server\): add features? to server$/);
    });

    it('handles pluralization correctly', async () => {
      const singleFile = ['src/feature.ts'];
      const multipleFiles = ['src/feature1.ts', 'src/feature2.ts'];

      const singleResult = await tool.execute({ changed_files: singleFile });
      const multipleResult = await tool.execute({ changed_files: multipleFiles });

      expect(singleResult.data.subject).toMatch(/add feature to/);
      expect(multipleResult.data.subject).toMatch(/add features to/);
    });
  });
});
