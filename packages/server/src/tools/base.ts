/**
 * Base Tool Interfaces and Utilities
 * 
 * Common interfaces and utilities shared across all MCP tools.
 */

export interface ToolResult<T = any> {
  /** Structured data for the tool result */
  data: T;
  /** One-line human-readable summary */
  summary: string;
  /** Success status */
  success: boolean;
  /** Optional error information */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface ToolContext {
  /** Working directory for the tool */
  cwd?: string;
  /** Whether to include verbose output */
  verbose?: boolean;
  /** Repository path override */
  repositoryPath?: string;
}

/**
 * Create a successful tool result
 */
export function createSuccessResult<T>(
  data: T, 
  summary: string, 
  metadata?: Record<string, any>
): ToolResult<T> {
  return {
    data,
    summary,
    success: true,
    metadata
  };
}

/**
 * Create a failed tool result
 */
export function createErrorResult<T = null>(
  error: string, 
  data?: T,
  metadata?: Record<string, any>
): ToolResult<T> {
  return {
    data: (data !== undefined ? data : null) as T,
    summary: `Error: ${error}`,
    success: false,
    error,
    metadata
  };
}

/**
 * Base class for MCP tools
 */
export abstract class BaseTool {
  protected readonly name: string;
  
  constructor(name: string) {
    this.name = name;
  }
  
  /**
   * Execute the tool with given arguments
   */
  abstract execute(args: any, context?: ToolContext): Promise<ToolResult>;
  
  /**
   * Get the tool's input schema for MCP
   */
  abstract getInputSchema(): any;
  
  /**
   * Get the tool's description for MCP
   */
  abstract getDescription(): string;
  
  /**
   * Get the repository path from context or use current directory
   */
  protected getRepositoryPath(context?: ToolContext): string {
    return context?.repositoryPath || context?.cwd || process.cwd();
  }
}
