/**
 * GitHub Adapter
 * 
 * Optional adapter for GitHub API integration, activated by GITHUB_TOKEN environment variable.
 * Provides pull request creation and management capabilities with policy integration.
 */

import { Octokit } from '@octokit/rest';
import { gitExec } from '../git/index.js';
import { policyLoader } from '../policy/index.js';
import type { PullRequestResult, PullRequestOptions, DiffStat, PullRequestCheck } from '../types.js';

export class GitHubAdapter {
  private octokit: Octokit;
  private enabled: boolean;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    this.enabled = !!token;
    
    if (this.enabled) {
      this.octokit = new Octokit({
        auth: token,
        userAgent: 'mcp-git-orchestrator/0.1.0'
      });
    } else {
      // Create a dummy Octokit instance for type safety
      this.octokit = {} as Octokit;
    }
  }

  /**
   * Check if GitHub integration is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Create a pull request
   */
  async createPullRequest(
    options: PullRequestOptions,
    repositoryPath: string
  ): Promise<PullRequestResult> {
    if (!this.enabled) {
      throw new Error('GitHub integration not enabled. Set GITHUB_TOKEN environment variable.');
    }

    // Get repository information
    const repoInfo = await this.getRepositoryInfo(repositoryPath);
    
    // Get policy defaults
    const policyResult = await policyLoader.loadPolicy(repositoryPath);
    const policy = policyResult.policy;
    
    // Determine head and base branches
    const head = options.head || await this.getCurrentBranch(repositoryPath);
    const base = options.base || policy.default_base || 'main';
    
    // Validate branches
    if (head === base) {
      throw new Error(`Cannot create PR: head branch '${head}' is the same as base branch '${base}'`);
    }
    
    // Get diffstat for the PR
    const diffstat = await this.generateDiffStat(head, base, repositoryPath);
    
    // Enhance PR body with diffstat and metadata
    const enhancedBody = await this.enhancePRBody(
      options.body || '',
      diffstat,
      head,
      base,
      repositoryPath
    );

    try {
      // Create the pull request
      const response = await this.octokit.rest.pulls.create({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        title: options.title,
        body: enhancedBody,
        head,
        base,
        draft: options.draft,
        maintainer_can_modify: options.maintainer_can_modify
      });

      const pr = response.data;

      // Add labels if specified
      if (options.labels && options.labels.length > 0) {
        await this.octokit.rest.issues.addLabels({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          issue_number: pr.number,
          labels: options.labels
        });
      }

      // Add assignees if specified
      if (options.assignees && options.assignees.length > 0) {
        await this.octokit.rest.issues.addAssignees({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          issue_number: pr.number,
          assignees: options.assignees
        });
      }

      // Request reviewers if specified
      if (options.reviewers && options.reviewers.length > 0) {
        await this.octokit.rest.pulls.requestReviewers({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          pull_number: pr.number,
          reviewers: options.reviewers
        });
      }

      // Get CI status checks
      const checks = await this.getPullRequestChecks(repoInfo.owner, repoInfo.repo, head);

      return {
        url: pr.html_url,
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        head: pr.head.ref,
        base: pr.base.ref,
        state: pr.state as 'open' | 'closed' | 'merged',
        createdAt: pr.created_at,
        diffstat,
        checks
      };

    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to create pull request: ${error.message}`);
      }
      throw new Error('Failed to create pull request: Unknown error');
    }
  }

  /**
   * Get repository information from Git remote
   */
  private async getRepositoryInfo(repositoryPath: string): Promise<{ owner: string; repo: string }> {
    try {
      const result = await gitExec.exec('remote', ['get-url', 'origin'], { cwd: repositoryPath });
      const remoteUrl = result.stdout.trim();
      
      // Parse GitHub URL (both HTTPS and SSH)
      let match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
      
      if (!match) {
        throw new Error(`Unable to parse GitHub repository from remote URL: ${remoteUrl}`);
      }
      
      const [, owner, repo] = match;
      return { owner, repo };
    } catch (error) {
      throw new Error(`Failed to get repository information: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get current branch name
   */
  private async getCurrentBranch(repositoryPath: string): Promise<string> {
    try {
      const result = await gitExec.exec('branch', ['--show-current'], { cwd: repositoryPath });
      const branch = result.stdout.trim();
      
      if (!branch) {
        throw new Error('Unable to determine current branch (detached HEAD?)');
      }
      
      return branch;
    } catch (error) {
      throw new Error(`Failed to get current branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate diffstat between two branches
   */
  private async generateDiffStat(head: string, base: string, repositoryPath: string): Promise<DiffStat> {
    try {
      // Get the diff stat
      const statResult = await gitExec.exec('diff', ['--stat', `${base}...${head}`], { cwd: repositoryPath });
      const statOutput = statResult.stdout.trim();
      
      // Get list of changed files
      const filesResult = await gitExec.exec('diff', ['--name-only', `${base}...${head}`], { cwd: repositoryPath });
      const changedFiles = filesResult.stdout.trim().split('\n').filter(f => f.length > 0);
      
      // Parse the stat output to get additions/deletions
      let additions = 0;
      let deletions = 0;
      
      if (statOutput) {
        const lines = statOutput.split('\n');
        const summaryLine = lines[lines.length - 1];
        
        // Look for pattern like "5 files changed, 123 insertions(+), 45 deletions(-)"
        const match = summaryLine.match(/(\d+) insertions?\(\+\)(?:, (\d+) deletions?\(-\))?/);
        if (match) {
          additions = parseInt(match[1]) || 0;
          deletions = parseInt(match[2]) || 0;
        }
      }
      
      return {
        files: changedFiles.length,
        additions,
        deletions,
        changedFiles
      };
    } catch (error) {
      // Return empty diffstat if we can't generate it
      return {
        files: 0,
        additions: 0,
        deletions: 0,
        changedFiles: []
      };
    }
  }

  /**
   * Enhance PR body with diffstat and metadata
   */
  private async enhancePRBody(
    originalBody: string,
    diffstat: DiffStat,
    head: string,
    base: string,
    repositoryPath: string
  ): Promise<string> {
    const sections: string[] = [];
    
    // Add original body if provided
    if (originalBody.trim()) {
      sections.push(originalBody.trim());
      sections.push(''); // Empty line separator
    }
    
    // Add diffstat section
    if (diffstat.files > 0) {
      sections.push('## 📊 Changes');
      sections.push(`- **${diffstat.files}** files changed`);
      sections.push(`- **${diffstat.additions}** insertions (+)`);
      sections.push(`- **${diffstat.deletions}** deletions (-)`);
      sections.push('');
      
      // Add file list if not too many files
      if (diffstat.changedFiles.length <= 10) {
        sections.push('### Modified Files');
        diffstat.changedFiles.forEach(file => {
          sections.push(`- \`${file}\``);
        });
        sections.push('');
      } else {
        sections.push(`### ${diffstat.changedFiles.length} files modified`);
        sections.push('(View full diff for complete file list)');
        sections.push('');
      }
    }
    
    // Add branch information
    sections.push('## 🌳 Branch Information');
    sections.push(`- **From**: \`${head}\``);
    sections.push(`- **To**: \`${base}\``);
    sections.push('');
    
    // Add policy compliance note
    try {
      const policyResult = await policyLoader.loadPolicy(repositoryPath);
      if (policyResult.policy.commit_style?.enforce_conventional) {
        sections.push('## ✅ Policy Compliance');
        sections.push('This PR follows the repository\'s commit conventions and policies.');
        sections.push('');
      }
    } catch {
      // Ignore policy loading errors for PR body
    }
    
    // Add footer
    sections.push('---');
    sections.push('*Created with MCP Git Orchestrator*');
    
    return sections.join('\n');
  }

  /**
   * Get pull request checks/CI status
   */
  private async getPullRequestChecks(owner: string, repo: string, ref: string): Promise<PullRequestCheck[]> {
    if (!this.enabled) {
      return [];
    }
    
    try {
      // Get check runs for the commit
      const response = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref
      });
      
      return response.data.check_runs.map(check => ({
        name: check.name,
        status: check.status as 'pending' | 'success' | 'failure' | 'error',
        conclusion: check.conclusion || undefined,
        url: check.html_url || undefined,
        description: check.output?.summary || undefined
      }));
    } catch (error) {
      // Return empty array if we can't get checks
      return [];
    }
  }
}

// Export singleton instance
export const githubAdapter = new GitHubAdapter();
