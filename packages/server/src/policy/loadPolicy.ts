/**
 * AI VCS Policy Loader
 * 
 * Loads and validates .ai-vcs-policy.yaml files from repositories.
 * Falls back to sensible defaults when no policy file is present.
 */

import { readFile, access } from 'fs/promises';
import { join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import type { AiVcsPolicy } from './defaults.js';
import { 
  DEFAULT_POLICY, 
  validatePolicy, 
  mergeWithDefaults,
  PolicyValidationResult 
} from './defaults.js';

export interface PolicyLoadResult {
  policy: AiVcsPolicy;
  source: 'file' | 'defaults';
  path?: string;
  validation: PolicyValidationResult;
  warnings: string[];
}

export class PolicyLoader {
  private readonly policyFileName = '.ai-vcs-policy.yaml';
  private policyCache = new Map<string, { policy: AiVcsPolicy; timestamp: number }>();
  private readonly cacheTimeout = 5 * 60 * 1000; // 5 minutes

  /**
   * Load policy for a given repository path
   */
  async loadPolicy(repositoryPath: string = process.cwd()): Promise<PolicyLoadResult> {
    const normalizedPath = resolve(repositoryPath);
    
    // Check cache first
    const cached = this.getCachedPolicy(normalizedPath);
    if (cached) {
      return {
        policy: cached.policy,
        source: 'file',
        path: join(normalizedPath, this.policyFileName),
        validation: PolicyValidationResult.valid(),
        warnings: []
      };
    }

    try {
      const policyPath = join(normalizedPath, this.policyFileName);
      
      // Check if policy file exists
      await access(policyPath);
      
      // Load and parse the policy file
      const result = await this.loadPolicyFile(policyPath);
      
      // Cache successful loads
      if (result.validation.isValid) {
        this.setCachedPolicy(normalizedPath, result.policy);
      }
      
      return result;
      
    } catch (error) {
      // Policy file doesn't exist or can't be read - use defaults
      return {
        policy: DEFAULT_POLICY,
        source: 'defaults',
        validation: PolicyValidationResult.valid(),
        warnings: [
          `No ${this.policyFileName} found in ${normalizedPath}, using defaults`
        ]
      };
    }
  }

  /**
   * Load and validate a specific policy file
   */
  async loadPolicyFile(filePath: string): Promise<PolicyLoadResult> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsedPolicy = this.parseYamlPolicy(content);
      const validation = validatePolicy(parsedPolicy);
      
      if (!validation.isValid) {
        return {
          policy: mergeWithDefaults(parsedPolicy),
          source: 'file',
          path: filePath,
          validation,
          warnings: [
            `Policy file has validation errors, merged with defaults`,
            ...validation.warnings
          ]
        };
      }
      
      const mergedPolicy = mergeWithDefaults(parsedPolicy);
      
      return {
        policy: mergedPolicy,
        source: 'file',
        path: filePath,
        validation,
        warnings: validation.warnings
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      return {
        policy: DEFAULT_POLICY,
        source: 'defaults',
        validation: PolicyValidationResult.invalid([{
          field: 'file',
          message: `Failed to load policy file: ${errorMessage}`,
          value: filePath
        }]),
        warnings: [`Failed to load ${filePath}, using defaults: ${errorMessage}`]
      };
    }
  }

  /**
   * Parse YAML content into a partial policy object
   */
  private parseYamlPolicy(content: string): Partial<AiVcsPolicy> {
    try {
      const parsed = parseYaml(content);
      
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Policy file must contain a YAML object');
      }
      
      return parsed as Partial<AiVcsPolicy>;
      
    } catch (error) {
      throw new Error(`Invalid YAML syntax: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get cached policy if still valid
   */
  private getCachedPolicy(repositoryPath: string): { policy: AiVcsPolicy } | null {
    const cached = this.policyCache.get(repositoryPath);
    
    if (!cached) {
      return null;
    }
    
    const now = Date.now();
    if (now - cached.timestamp > this.cacheTimeout) {
      this.policyCache.delete(repositoryPath);
      return null;
    }
    
    return { policy: cached.policy };
  }

  /**
   * Cache a policy for a repository
   */
  private setCachedPolicy(repositoryPath: string, policy: AiVcsPolicy): void {
    this.policyCache.set(repositoryPath, {
      policy,
      timestamp: Date.now()
    });
  }

  /**
   * Clear cache for a specific repository or all repositories
   */
  clearCache(repositoryPath?: string): void {
    if (repositoryPath) {
      this.policyCache.delete(resolve(repositoryPath));
    } else {
      this.policyCache.clear();
    }
  }

  /**
   * Check if a branch is protected according to the policy
   */
  isBranchProtected(policy: AiVcsPolicy, branchName: string): boolean {
    return policy.protected_branches.some(pattern => {
      // Support simple glob patterns
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(branchName);
      }
      return pattern === branchName;
    });
  }

  /**
   * Validate branch name against policy
   */
  validateBranchName(policy: AiVcsPolicy, branchName: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Check length
    if (branchName.length > policy.branch_naming.max_length) {
      errors.push(`Branch name exceeds maximum length of ${policy.branch_naming.max_length} characters`);
    }
    
    // Check pattern
    if (policy.branch_naming.pattern) {
      const regex = new RegExp(policy.branch_naming.pattern);
      if (!regex.test(branchName)) {
        errors.push(`Branch name does not match required pattern: ${policy.branch_naming.pattern}`);
      }
    }
    
    // Check forbidden patterns
    for (const forbiddenPattern of policy.branch_naming.forbidden_patterns) {
      const regex = new RegExp(forbiddenPattern);
      if (regex.test(branchName)) {
        errors.push(`Branch name matches forbidden pattern: ${forbiddenPattern}`);
      }
    }
    
    // Check allowed prefixes
    if (policy.branch_naming.allowed_prefixes.length > 0) {
      const hasValidPrefix = policy.branch_naming.allowed_prefixes.some(prefix => 
        branchName.startsWith(prefix)
      );
      
      if (!hasValidPrefix) {
        errors.push(`Branch name must start with one of: ${policy.branch_naming.allowed_prefixes.join(', ')}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate commit message against policy
   */
  validateCommitMessage(policy: AiVcsPolicy, message: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const lines = message.split('\n');
    const subject = lines[0] || '';
    
    // Check subject length
    if (subject.length > policy.commit_style.max_subject_length) {
      errors.push(`Subject line exceeds maximum length of ${policy.commit_style.max_subject_length} characters`);
    }
    
    // Check conventional commits format
    if (policy.commit_style.enforce_conventional) {
      const conventionalRegex = /^([\w-]+)(?:\([^)]+\))?: (.+)$/;
      const match = subject.match(conventionalRegex);
      
      if (!match) {
        errors.push('Commit message must follow conventional commits format: type(scope): description');
      } else {
        const [, type] = match;
        
        if (!policy.commit_style.allowed_types.includes(type)) {
          errors.push(`Commit type '${type}' is not allowed. Use one of: ${policy.commit_style.allowed_types.join(', ')}`);
        }
        
        // Check if body is required for this type
        if (policy.commit_style.require_body_for.includes(type)) {
          const hasBody = lines.length > 2 && lines.slice(2).some(line => line.trim());
          if (!hasBody) {
            errors.push(`Commit type '${type}' requires a body explaining the changes`);
          }
        }
      }
    }
    
    // Check required trailers
    for (const requiredTrailer of policy.commit_style.required_trailers) {
      const trailerRegex = new RegExp(`^${requiredTrailer}:\\s+.+$`, 'm');
      if (!trailerRegex.test(message)) {
        errors.push(`Missing required trailer: ${requiredTrailer}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Check if an operation should trigger a safety snapshot
   */
  shouldCreateSnapshot(policy: AiVcsPolicy, operation: string): boolean {
    return policy.safety_snapshots.auto_create && 
           policy.safety_snapshots.trigger_operations.includes(operation);
  }

  /**
   * Get prepush checks that should be run
   */
  getPrepushChecks(policy: AiVcsPolicy, requireRequired = false): typeof policy.prepush_checks {
    if (requireRequired) {
      return policy.prepush_checks.filter(check => check.required);
    }
    return policy.prepush_checks;
  }
}

// Singleton instance
export const policyLoader = new PolicyLoader();

/**
 * Convenience function to load policy for current directory
 */
export async function loadCurrentPolicy(): Promise<PolicyLoadResult> {
  return policyLoader.loadPolicy();
}

/**
 * Convenience function to check if current repo has a policy file
 */
export async function hasPolicyFile(repositoryPath: string = process.cwd()): Promise<boolean> {
  try {
    await access(join(repositoryPath, '.ai-vcs-policy.yaml'));
    return true;
  } catch {
    return false;
  }
}
