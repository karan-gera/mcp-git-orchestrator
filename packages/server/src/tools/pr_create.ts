/**
 * Pull Request Creation Tool
 * 
 * Creates GitHub pull requests with policy integration, diffstat, and CI status.
 * Only available when GITHUB_TOKEN environment variable is present.
 */

import { BaseTool, createSuccessResult, createErrorResult, type ToolResult, type ToolContext } from './base.js';
import { githubAdapter } from '../adapters/github.js';
import { policyLoader } from '../policy/index.js';
import type { PullRequestResult, PullRequestOptions } from '../types.js';

export interface PrCreateArgs {
  /** PR title (required) */
  title: string;
  /** PR description/body */
  body?: string;
  /** Head branch (default: current branch) */
  head?: string;
  /** Base branch (default: from policy or 'main') */
  base?: string;
  /** Create as draft PR */
  draft?: boolean;
  /** Allow maintainers to modify */
  maintainer_can_modify?: boolean;
  /** Labels to add to PR */
  labels?: string[];
  /** Users to assign to PR */
  assignees?: string[];
  /** Users to request reviews from */
  reviewers?: string[];
  /** Milestone number */
  milestone?: number;
}

export class PrCreateTool extends BaseTool {
  constructor() {
    super('pr_create');
  }

  getDescription(): string {
    return 'Create GitHub pull requests with policy integration and automated diffstat (requires GITHUB_TOKEN)';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Pull request title (required)',
          minLength: 1
        },
        body: {
          type: 'string',
          description: 'Pull request description/body'
        },
        head: {
          type: 'string',
          description: 'Head branch (default: current branch)'
        },
        base: {
          type: 'string',
          description: 'Base branch (default: from policy or main)'
        },
        draft: {
          type: 'boolean',
          description: 'Create as draft PR',
          default: false
        },
        maintainer_can_modify: {
          type: 'boolean',
          description: 'Allow maintainers to modify PR',
          default: true
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels to add to PR'
        },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Users to assign to PR'
        },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Users to request reviews from'
        },
        milestone: {
          type: 'number',
          description: 'Milestone number'
        }
      },
      required: ['title']
    };
  }

  async execute(args: PrCreateArgs, context?: ToolContext): Promise<ToolResult<PullRequestResult>> {
    const { title, body, head, base, draft, maintainer_can_modify, labels, assignees, reviewers, milestone } = args;

    try {
      const repositoryPath = this.getRepositoryPath(context);

      // Check if GitHub integration is enabled
      if (!githubAdapter.isEnabled()) {
        return createErrorResult(
          'GitHub integration not enabled',
          undefined,
          { 
            hint: 'Set GITHUB_TOKEN environment variable to enable GitHub features',
            repositoryPath 
          }
        );
      }

      // Validate title
      if (!title || title.trim().length === 0) {
        return createErrorResult(
          'PR title is required',
          undefined,
          { repositoryPath }
        );
      }

      // Load policy for validation
      const policyResult = await policyLoader.loadPolicy(repositoryPath);
      const policy = policyResult.policy;

      // Validate base branch against protected branches
      const effectiveBase = base || policy.default_base || 'main';
      if (policy.protected_branches && policy.protected_branches.includes(effectiveBase)) {
        // This is actually okay for PRs - they target protected branches
        // We just want to note it in metadata
      }

      // Prepare PR options
      const prOptions: PullRequestOptions = {
        title: title.trim(),
        body: body?.trim(),
        head,
        base: effectiveBase,
        draft,
        maintainer_can_modify,
        labels,
        assignees,
        reviewers,
        milestone
      };

      // Create the pull request
      const result = await githubAdapter.createPullRequest(prOptions, repositoryPath);

      const metadata = {
        repositoryPath,
        policy: {
          base_branch: effectiveBase,
          protected_branches: policy.protected_branches,
          enforce_conventional: policy.commit_style?.enforce_conventional
        },
        github_integration: {
          enabled: true,
          checks_available: result.checks && result.checks.length > 0
        }
      };

      const summary = this.generateSummary(result);

      return createSuccessResult(result, summary, metadata);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      
      return createErrorResult(
        errorMessage,
        undefined,
        { 
          github_integration: githubAdapter.isEnabled(),
          repositoryPath: this.getRepositoryPath(context)
        }
      );
    }
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(result: PullRequestResult): string {
    const parts: string[] = [];
    
    parts.push(`Created PR #${result.number}: "${result.title}"`);
    
    if (result.diffstat) {
      const { files, additions, deletions } = result.diffstat;
      if (files > 0) {
        parts.push(`${files} files, +${additions}/-${deletions}`);
      }
    }
    
    if (result.state === 'open') {
      parts.push('Ready for review');
    }
    
    if (result.checks && result.checks.length > 0) {
      const pendingChecks = result.checks.filter(c => c.status === 'pending').length;
      if (pendingChecks > 0) {
        parts.push(`${pendingChecks} checks pending`);
      }
    }
    
    return parts.join(', ');
  }
}

/**
 * Check if PR creation is available
 */
export function isPrCreateAvailable(): boolean {
  return githubAdapter.isEnabled();
}
