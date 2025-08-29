/**
 * PR Create Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrCreateTool, isPrCreateAvailable } from '../pr_create.js';
import { githubAdapter } from '../../adapters/github.js';

// Mock the GitHub adapter
vi.mock('../../adapters/github.js', () => ({
  githubAdapter: {
    isEnabled: vi.fn(),
    createPullRequest: vi.fn()
  }
}));

// Mock the policy loader
vi.mock('../../policy/index.js', () => ({
  policyLoader: {
    loadPolicy: vi.fn()
  }
}));

describe('PrCreateTool', () => {
  let tool: PrCreateTool;
  const mockGitHubAdapter = vi.mocked(githubAdapter);

  beforeEach(() => {
    tool = new PrCreateTool();
    vi.clearAllMocks();
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Create GitHub pull requests with policy integration and automated diffstat (requires GITHUB_TOKEN)');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('title');
      expect(schema.properties.title).toHaveProperty('minLength', 1);
      expect(schema.required).toContain('title');
    });
  });

  describe('execute', () => {
    it('returns error when GitHub integration is not enabled', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(false);

      const result = await tool.execute({ title: 'Test PR' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('GitHub integration not enabled');
      expect(result.metadata?.hint).toContain('Set GITHUB_TOKEN');
    });

    it('returns error when title is empty', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);

      const result = await tool.execute({ title: '' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('PR title is required');
    });

    it('creates PR successfully with minimal args', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      
      const mockPR = {
        url: 'https://github.com/owner/repo/pull/123',
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        head: 'feature-branch',
        base: 'main',
        state: 'open' as const,
        createdAt: '2024-01-01T00:00:00Z',
        diffstat: {
          files: 2,
          additions: 10,
          deletions: 5,
          changedFiles: ['src/file1.ts', 'src/file2.ts']
        },
        checks: []
      };
      
      mockGitHubAdapter.createPullRequest.mockResolvedValue(mockPR);

      // Mock policy loader
      const { policyLoader } = await import('../../policy/index.js');
      vi.mocked(policyLoader.loadPolicy).mockResolvedValue({
        protected_branches: ['main'],
        default_base: 'main',
        commit_style: { enforce_conventional: true },
        branch_naming: { pattern: '' },
        deny_force_push: true,
        prepush_checks: [],
        merge_strategy: 'merge',
        safety_snapshots: { auto_stash: true, worktree_for_conflicts: true }
      });

      const result = await tool.execute({ 
        title: 'Test PR',
        body: 'Test description'
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPR);
      expect(result.summary).toContain('Created PR #123');
      expect(result.summary).toContain('2 files, +10/-5');
      expect(mockGitHubAdapter.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test PR',
          body: 'Test description',
          base: 'main'
        }),
        expect.any(String)
      );
    });

    it('creates PR with all optional parameters', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      
      const mockPR = {
        url: 'https://github.com/owner/repo/pull/124',
        number: 124,
        title: 'Feature: Add new functionality',
        body: 'Detailed description',
        head: 'feature-new-functionality',
        base: 'develop',
        state: 'open' as const,
        createdAt: '2024-01-01T00:00:00Z',
        diffstat: {
          files: 5,
          additions: 50,
          deletions: 10,
          changedFiles: ['src/feature.ts', 'tests/feature.test.ts']
        },
        checks: [
          {
            name: 'CI',
            status: 'pending' as const,
            conclusion: undefined,
            url: 'https://github.com/owner/repo/actions/runs/123',
            description: 'Running tests'
          }
        ]
      };
      
      mockGitHubAdapter.createPullRequest.mockResolvedValue(mockPR);

      // Mock policy loader
      const { policyLoader } = await import('../../policy/index.js');
      vi.mocked(policyLoader.loadPolicy).mockResolvedValue({
        protected_branches: ['main', 'develop'],
        default_base: 'develop',
        commit_style: { enforce_conventional: true },
        branch_naming: { pattern: '' },
        deny_force_push: true,
        prepush_checks: [],
        merge_strategy: 'merge',
        safety_snapshots: { auto_stash: true, worktree_for_conflicts: true }
      });

      const result = await tool.execute({
        title: 'Feature: Add new functionality',
        body: 'Detailed description',
        head: 'feature-new-functionality',
        base: 'develop',
        draft: true,
        maintainer_can_modify: false,
        labels: ['feature', 'enhancement'],
        assignees: ['developer1'],
        reviewers: ['reviewer1', 'reviewer2'],
        milestone: 1
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockPR);
      expect(result.summary).toContain('Created PR #124');
      expect(result.summary).toContain('5 files, +50/-10');
      expect(result.summary).toContain('1 checks pending');
      
      expect(mockGitHubAdapter.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Feature: Add new functionality',
          body: 'Detailed description',
          head: 'feature-new-functionality',
          base: 'develop',
          draft: true,
          maintainer_can_modify: false,
          labels: ['feature', 'enhancement'],
          assignees: ['developer1'],
          reviewers: ['reviewer1', 'reviewer2'],
          milestone: 1
        }),
        expect.any(String)
      );
    });

    it('handles GitHub API errors gracefully', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      mockGitHubAdapter.createPullRequest.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await tool.execute({ title: 'Test PR' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('API rate limit exceeded');
      expect(result.metadata?.github_integration).toBe(true);
    });

    it('includes policy information in metadata', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      
      const mockPR = {
        url: 'https://github.com/owner/repo/pull/125',
        number: 125,
        title: 'Test PR',
        body: '',
        head: 'test-branch',
        base: 'main',
        state: 'open' as const,
        createdAt: '2024-01-01T00:00:00Z'
      };
      
      mockGitHubAdapter.createPullRequest.mockResolvedValue(mockPR);

      // Mock policy loader with specific policy
      const { policyLoader } = await import('../../policy/index.js');
      vi.mocked(policyLoader.loadPolicy).mockResolvedValue({
        protected_branches: ['main', 'release'],
        default_base: 'main',
        commit_style: { enforce_conventional: true },
        branch_naming: { pattern: '' },
        deny_force_push: true,
        prepush_checks: [],
        merge_strategy: 'merge',
        safety_snapshots: { auto_stash: true, worktree_for_conflicts: true }
      });

      const result = await tool.execute({ title: 'Test PR' });

      expect(result.success).toBe(true);
      expect(result.metadata?.policy).toEqual({
        base_branch: 'main',
        protected_branches: ['main', 'release'],
        enforce_conventional: true
      });
      expect(result.metadata?.github_integration).toEqual({
        enabled: true,
        checks_available: false
      });
    });
  });

  describe('isPrCreateAvailable', () => {
    it('returns true when GitHub adapter is enabled', () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      
      expect(isPrCreateAvailable()).toBe(true);
    });

    it('returns false when GitHub adapter is disabled', () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(false);
      
      expect(isPrCreateAvailable()).toBe(false);
    });
  });

  describe('generateSummary', () => {
    it('generates summary for PR with diffstat and checks', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      
      const mockPR = {
        url: 'https://github.com/owner/repo/pull/126',
        number: 126,
        title: 'Complex Feature',
        body: '',
        head: 'complex-feature',
        base: 'main',
        state: 'open' as const,
        createdAt: '2024-01-01T00:00:00Z',
        diffstat: {
          files: 10,
          additions: 200,
          deletions: 50,
          changedFiles: []
        },
        checks: [
          { name: 'Build', status: 'success' as const },
          { name: 'Tests', status: 'pending' as const },
          { name: 'Lint', status: 'pending' as const }
        ]
      };
      
      mockGitHubAdapter.createPullRequest.mockResolvedValue(mockPR);

      // Mock policy loader
      const { policyLoader } = await import('../../policy/index.js');
      vi.mocked(policyLoader.loadPolicy).mockResolvedValue({
        protected_branches: [],
        default_base: 'main',
        commit_style: { enforce_conventional: false },
        branch_naming: { pattern: '' },
        deny_force_push: true,
        prepush_checks: [],
        merge_strategy: 'merge',
        safety_snapshots: { auto_stash: true, worktree_for_conflicts: true }
      });

      const result = await tool.execute({ title: 'Complex Feature' });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Created PR #126: "Complex Feature", 10 files, +200/-50, Ready for review, 2 checks pending');
    });

    it('generates simple summary when no diffstat available', async () => {
      mockGitHubAdapter.isEnabled.mockReturnValue(true);
      
      const mockPR = {
        url: 'https://github.com/owner/repo/pull/127',
        number: 127,
        title: 'Simple Fix',
        body: '',
        head: 'simple-fix',
        base: 'main',
        state: 'open' as const,
        createdAt: '2024-01-01T00:00:00Z'
      };
      
      mockGitHubAdapter.createPullRequest.mockResolvedValue(mockPR);

      // Mock policy loader
      const { policyLoader } = await import('../../policy/index.js');
      vi.mocked(policyLoader.loadPolicy).mockResolvedValue({
        protected_branches: [],
        default_base: 'main',
        commit_style: { enforce_conventional: false },
        branch_naming: { pattern: '' },
        deny_force_push: true,
        prepush_checks: [],
        merge_strategy: 'merge',
        safety_snapshots: { auto_stash: true, worktree_for_conflicts: true }
      });

      const result = await tool.execute({ title: 'Simple Fix' });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Created PR #127: "Simple Fix", Ready for review');
    });
  });
});
