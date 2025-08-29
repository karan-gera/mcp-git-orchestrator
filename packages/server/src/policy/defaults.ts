/**
 * AI VCS Policy Defaults and Types
 * 
 * Defines the schema for .ai-vcs-policy.yaml and provides sensible defaults
 * for Git operations when no policy file is present.
 */

// Policy Schema Types
export interface AiVcsPolicy {
  /** Version of the policy schema */
  version: string;
  
  /** Branches that require special protection */
  protected_branches: string[];
  
  /** Default base branch for new branches */
  default_base: string;
  
  /** Commit message style enforcement */
  commit_style: CommitStyle;
  
  /** Branch naming conventions */
  branch_naming: BranchNaming;
  
  /** Force push restrictions */
  deny_force_push: boolean;
  
  /** Pre-push validation checks */
  prepush_checks: PrepushCheck[];
  
  /** Merge strategy preferences */
  merge_strategy: MergeStrategy;
  
  /** Automatic safety snapshot settings */
  safety_snapshots: SafetySnapshots;
  
  /** Repository-specific settings */
  repository: RepositorySettings;
}

export interface CommitStyle {
  /** Enforce conventional commits format */
  enforce_conventional: boolean;
  
  /** Required conventional commit types */
  allowed_types: string[];
  
  /** Require scope in commit messages */
  require_scope: boolean;
  
  /** Maximum subject line length */
  max_subject_length: number;
  
  /** Require body for certain types */
  require_body_for: string[];
  
  /** Required trailers (e.g., Signed-off-by) */
  required_trailers: string[];
}

export interface BranchNaming {
  /** Branch naming pattern enforcement */
  pattern: string;
  
  /** Allowed prefixes for branches */
  allowed_prefixes: string[];
  
  /** Maximum branch name length */
  max_length: number;
  
  /** Disallow certain patterns */
  forbidden_patterns: string[];
}

export interface PrepushCheck {
  /** Name of the check */
  name: string;
  
  /** Command to run for validation */
  command: string;
  
  /** Whether check is mandatory */
  required: boolean;
  
  /** Timeout for the check in seconds */
  timeout: number;
  
  /** Working directory for the command */
  cwd?: string;
}

export interface MergeStrategy {
  /** Default merge strategy */
  default_strategy: 'merge' | 'rebase' | 'squash';
  
  /** Require pull request for protected branches */
  require_pr: boolean;
  
  /** Auto-delete feature branches after merge */
  auto_delete_merged: boolean;
  
  /** Require clean working tree for merge */
  require_clean_tree: boolean;
}

export interface SafetySnapshots {
  /** Automatically create snapshots before risky operations */
  auto_create: boolean;
  
  /** Snapshot method preference */
  method: 'stash' | 'worktree';
  
  /** Retention policy for snapshots */
  retention_days: number;
  
  /** Operations that trigger snapshots */
  trigger_operations: string[];
}

export interface RepositorySettings {
  /** Repository name/identifier */
  name?: string;
  
  /** Repository type/purpose */
  type?: 'library' | 'application' | 'documentation' | 'other';
  
  /** Team/ownership information */
  team?: string;
  
  /** Custom Git hooks to respect */
  respect_hooks: boolean;
  
  /** Submodule handling preferences */
  submodules: SubmoduleSettings;
}

export interface SubmoduleSettings {
  /** How to handle submodule updates */
  update_strategy: 'ignore' | 'warn' | 'auto-update';
  
  /** Require explicit confirmation for submodule changes */
  require_confirmation: boolean;
}

// Default Policy Configuration
export const DEFAULT_POLICY: AiVcsPolicy = {
  version: '1.0',
  
  protected_branches: ['main', 'master', 'develop', 'production'],
  
  default_base: 'main',
  
  commit_style: {
    enforce_conventional: true,
    allowed_types: [
      'feat',     // New feature
      'fix',      // Bug fix
      'docs',     // Documentation
      'style',    // Formatting, missing semicolons, etc.
      'refactor', // Code change that neither fixes a bug nor adds a feature
      'perf',     // Performance improvement
      'test',     // Adding missing tests
      'chore',    // Changes to build process or auxiliary tools
      'ci',       // CI/CD changes
      'build',    // Build system changes
      'revert'    // Revert previous commit
    ],
    require_scope: false,
    max_subject_length: 72,
    require_body_for: ['feat', 'fix', 'perf', 'refactor'],
    required_trailers: []
  },
  
  branch_naming: {
    pattern: '^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)\/[a-z0-9-]+$',
    allowed_prefixes: [
      'feat/',
      'fix/', 
      'docs/',
      'style/',
      'refactor/',
      'perf/',
      'test/',
      'chore/',
      'ci/',
      'build/',
      'hotfix/',
      'release/'
    ],
    max_length: 50,
    forbidden_patterns: [
      '.*[A-Z].*',        // No uppercase letters
      '.*[_].*',          // No underscores
      '.*[-]{2,}.*',      // No multiple consecutive dashes
      '^[0-9].*',         // Cannot start with number
      '.*[.].*'           // No dots
    ]
  },
  
  deny_force_push: true,
  
  prepush_checks: [
    {
      name: 'lint',
      command: 'npm run lint || pnpm lint || yarn lint || echo "No lint script found"',
      required: false,
      timeout: 60,
      cwd: '.'
    },
    {
      name: 'test',
      command: 'npm test || pnpm test || yarn test || echo "No test script found"',
      required: false,
      timeout: 300,
      cwd: '.'
    },
    {
      name: 'build',
      command: 'npm run build || pnpm build || yarn build || echo "No build script found"',
      required: false,
      timeout: 180,
      cwd: '.'
    }
  ],
  
  merge_strategy: {
    default_strategy: 'merge',
    require_pr: true,
    auto_delete_merged: false,
    require_clean_tree: true
  },
  
  safety_snapshots: {
    auto_create: true,
    method: 'stash',
    retention_days: 7,
    trigger_operations: [
      'rebase',
      'merge',
      'reset',
      'cherry-pick',
      'revert'
    ]
  },
  
  repository: {
    type: 'other',
    respect_hooks: true,
    submodules: {
      update_strategy: 'warn',
      require_confirmation: true
    }
  }
};

// Policy Validation
export interface PolicyValidationError {
  field: string;
  message: string;
  value?: any;
}

export class PolicyValidationResult {
  constructor(
    public readonly isValid: boolean,
    public readonly errors: PolicyValidationError[] = [],
    public readonly warnings: string[] = []
  ) {}
  
  static valid(): PolicyValidationResult {
    return new PolicyValidationResult(true);
  }
  
  static invalid(errors: PolicyValidationError[], warnings: string[] = []): PolicyValidationResult {
    return new PolicyValidationResult(false, errors, warnings);
  }
}

/**
 * Validate a policy configuration against the schema
 */
export function validatePolicy(policy: Partial<AiVcsPolicy>): PolicyValidationResult {
  const errors: PolicyValidationError[] = [];
  const warnings: string[] = [];
  
  // Version check
  if (!policy.version) {
    errors.push({
      field: 'version',
      message: 'Policy version is required'
    });
  } else if (policy.version !== '1.0') {
    warnings.push(`Policy version ${policy.version} may not be fully supported`);
  }
  
  // Protected branches validation
  if (policy.protected_branches && !Array.isArray(policy.protected_branches)) {
    errors.push({
      field: 'protected_branches',
      message: 'Protected branches must be an array of strings',
      value: policy.protected_branches
    });
  }
  
  // Default base validation
  if (policy.default_base && typeof policy.default_base !== 'string') {
    errors.push({
      field: 'default_base',
      message: 'Default base must be a string',
      value: policy.default_base
    });
  }
  
  // Commit style validation
  if (policy.commit_style) {
    const cs = policy.commit_style;
    
    if (cs.max_subject_length && (cs.max_subject_length < 10 || cs.max_subject_length > 200)) {
      errors.push({
        field: 'commit_style.max_subject_length',
        message: 'Max subject length must be between 10 and 200 characters',
        value: cs.max_subject_length
      });
    }
    
    if (cs.allowed_types && !Array.isArray(cs.allowed_types)) {
      errors.push({
        field: 'commit_style.allowed_types',
        message: 'Allowed types must be an array of strings',
        value: cs.allowed_types
      });
    }
  }
  
  // Branch naming validation
  if (policy.branch_naming) {
    const bn = policy.branch_naming;
    
    if (bn.pattern) {
      try {
        new RegExp(bn.pattern);
      } catch (e) {
        errors.push({
          field: 'branch_naming.pattern',
          message: 'Branch naming pattern is not a valid regular expression',
          value: bn.pattern
        });
      }
    }
    
    if (bn.max_length && (bn.max_length < 5 || bn.max_length > 100)) {
      errors.push({
        field: 'branch_naming.max_length',
        message: 'Branch max length must be between 5 and 100 characters',
        value: bn.max_length
      });
    }
  }
  
  // Prepush checks validation
  if (policy.prepush_checks) {
    if (!Array.isArray(policy.prepush_checks)) {
      errors.push({
        field: 'prepush_checks',
        message: 'Prepush checks must be an array',
        value: policy.prepush_checks
      });
    } else {
      policy.prepush_checks.forEach((check, index) => {
        if (!check.name || typeof check.name !== 'string') {
          errors.push({
            field: `prepush_checks[${index}].name`,
            message: 'Prepush check name is required and must be a string',
            value: check.name
          });
        }
        
        if (!check.command || typeof check.command !== 'string') {
          errors.push({
            field: `prepush_checks[${index}].command`,
            message: 'Prepush check command is required and must be a string',
            value: check.command
          });
        }
        
        if (check.timeout && (check.timeout < 1 || check.timeout > 3600)) {
          errors.push({
            field: `prepush_checks[${index}].timeout`,
            message: 'Prepush check timeout must be between 1 and 3600 seconds',
            value: check.timeout
          });
        }
      });
    }
  }
  
  return errors.length > 0 
    ? PolicyValidationResult.invalid(errors, warnings)
    : PolicyValidationResult.valid();
}

/**
 * Merge user policy with defaults, ensuring all required fields are present
 */
export function mergeWithDefaults(userPolicy: Partial<AiVcsPolicy>): AiVcsPolicy {
  return {
    ...DEFAULT_POLICY,
    ...userPolicy,
    commit_style: {
      ...DEFAULT_POLICY.commit_style,
      ...userPolicy.commit_style
    },
    branch_naming: {
      ...DEFAULT_POLICY.branch_naming,
      ...userPolicy.branch_naming
    },
    merge_strategy: {
      ...DEFAULT_POLICY.merge_strategy,
      ...userPolicy.merge_strategy
    },
    safety_snapshots: {
      ...DEFAULT_POLICY.safety_snapshots,
      ...userPolicy.safety_snapshots
    },
    repository: {
      ...DEFAULT_POLICY.repository,
      ...userPolicy.repository,
      submodules: {
        ...DEFAULT_POLICY.repository.submodules,
        ...userPolicy.repository?.submodules
      }
    }
  };
}
