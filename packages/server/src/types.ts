/**
 * Type definitions for MCP Git Orchestrator
 * 
 * Defines all input/output types for Git operations and tool interfaces.
 */

// Repository Overview Types
export interface RepoOverview {
  root: string;
  branch: string;
  head: string;
  remotes: Remote[];
  aheadBehind: AheadBehind;
}

export interface Remote {
  name: string;
  url: string;
  type: 'fetch' | 'push';
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

// Git Status Types
export interface GitStatus {
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
}

export interface FileStatus {
  path: string;
  status: GitFileStatus;
  similarity?: number; // For renamed files
  oldPath?: string; // For renamed files
}

export type GitFileStatus = 
  | 'added'
  | 'modified' 
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmodified'
  | 'unmerged';

// Diff Types
export interface DiffResult {
  files: DiffFile[];
  hunks: DiffHunk[];
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface DiffHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'addition' | 'deletion';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffOptions {
  scope: 'staged' | 'unstaged' | 'path';
  path?: string;
  contextLines?: number;
}

// Commit Types
export interface CommitProposal {
  subject: string;
  body?: string;
  trailers: CommitTrailer[];
}

export interface CommitTrailer {
  key: string;
  value: string;
}

export interface CommitResult {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface CommitOptions {
  message: string;
  sign?: boolean;
  noVerify?: boolean;
  amend?: boolean;
}

// Branch Types
// BranchResult moved to later section

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  sha: string;
}

// BranchOptions moved to later section

// Stage Types
export interface StageResult {
  stagedCount: number;
  files: string[];
}

export interface HunkSelector {
  file: string;
  hunkIndex: number;
  lines?: number[]; // Specific lines within the hunk
}

export interface StageOptions {
  paths?: string[];
  hunks?: HunkSelector[];
  patch?: boolean;
}

// Merge Types
export interface MergeResult {
  forecasts: ConflictForecast[];
  success: boolean;
  conflicts?: ConflictRegion[];
}

// ConflictForecast moved to later section

// ConflictRegion moved to later section

export interface MergeOptions {
  target: string;
  strategy?: 'ours' | 'theirs' | 'recursive';
  noCommit?: boolean;
  squash?: boolean;
}

// Push Types (moved to later section)

// Log Types
export interface LogEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
  refs?: string[];
}

export interface LogOptions {
  maxCount?: number;
  since?: string;
  until?: string;
  author?: string;
  grep?: string;
  path?: string;
  oneline?: boolean;
}

// Stash Types
export interface StashEntry {
  index: number;
  description: string;
  branch: string;
  sha: string;
}

export interface StashOptions {
  message?: string;
  includeUntracked?: boolean;
  keepIndex?: boolean;
  patch?: boolean;
}

// Dry Run Types
export interface GitPlanStep {
  operation: string;
  args: string[];
  description: string;
  riskLevel: 'safe' | 'medium' | 'high';
}

export interface DryRunResult {
  ok: boolean;
  transcript: string[];
  warnings: string[];
  errors: string[];
}

// Error Types
export interface GitError {
  code: number;
  message: string;
  stderr: string;
  command: string;
}

// Safety Types
export interface SafetySnapshot {
  type: 'worktree' | 'stash';
  ref: string;
  path?: string;
  restoreCommand: string;
  createdAt: string;
}

// Staging Types
export interface StageResult {
  stagedCount: number;
  files: string[];
}

export interface StageOptions {
  paths?: string[];
  hunks?: HunkSelector[];
  patch?: boolean;
}

// Commit Types
export interface CommitResult {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface CommitOptions {
  message: string;
  sign?: boolean;
  noVerify?: boolean;
  amend?: boolean;
}

// Push Types
export interface PushResult {
  remote: string;
  branch: string;
  outcome: 'success' | 'rejected' | 'up-to-date';
  summary: string;
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

// Pre-push Check Types
export interface PrepushCheck {
  name: string;
  command: string;
  required: boolean;
  timeout: number;
  cwd?: string;
}

// Branch Types
export interface BranchResult {
  operation: 'create' | 'switch' | 'delete' | 'list';
  branch?: string;
  success: boolean;
  current?: boolean;
  from?: string;
  tracking?: boolean;
  forced?: boolean;
  message?: string;
  branches?: Array<{
    name: string;
    current: boolean;
    remote: boolean;
    upstream?: string;
    sha: string;
  }>;
}

export interface BranchOptions {
  operation: 'create' | 'switch' | 'delete' | 'list';
  name?: string;
  from?: string;
  track?: boolean;
}

// Merge Types
export interface MergePreflightResult {
  currentBranch: string;
  targetBranch: string;
  strategy: 'merge' | 'rebase' | 'squash';
  canMerge: boolean;
  conflicts: ConflictRegion[];
  forecast: ConflictForecast;
  policyViolations: string[];
  analysis?: any;
}

export interface ConflictForecast {
  riskLevel: 'low' | 'medium' | 'high';
  confidence: number;
  estimatedConflicts: number;
  recommendations: string[];
}

export interface ConflictRegion {
  file: string;
  type: 'content' | 'binary' | 'mode';
  severity: 'low' | 'medium' | 'high';
  lineStart: number;
  lineEnd: number;
  description: string;
  conflictMarkers: number;
}

// Git Command Types (for allowlist)
export type AllowedGitCommand = 
  | 'status'
  | 'diff'
  | 'add'
  | 'commit'
  | 'branch'
  | 'switch'
  | 'checkout'
  | 'fetch'
  | 'rebase'
  | 'merge'
  | 'push'
  | 'stash'
  | 'rev-parse'
  | 'log'
  | 'show'
  | 'ls-files'
  | 'symbolic-ref'
  | 'remote'
  | 'apply'
  | 'merge-base'
  | 'worktree';

export interface GitExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  input?: string;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}
