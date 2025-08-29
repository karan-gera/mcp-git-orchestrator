/**
 * Git Output Parsers
 * 
 * Parses Git command output into structured TypeScript objects.
 * Handles status, diff, log, and other Git command outputs.
 */

import type {
  GitStatus,
  FileStatus,
  GitFileStatus,
  DiffResult,
  DiffFile,
  DiffHunk,
  DiffLine,
  LogEntry,
  BranchInfo,
  Remote,
  AheadBehind,
  StashEntry
} from '../types.js';

/**
 * Parse git status --porcelain=v1 output
 */
export function parseGitStatus(output: string): GitStatus {
  const lines = output.split('\n').filter(line => line.trim());
  const staged: FileStatus[] = [];
  const unstaged: FileStatus[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.length < 3) continue;

    const stagedChar = line[0];
    const unstagedChar = line[1];
    const path = line.slice(3);

    // Handle renames (format: "R  old -> new")
    if (stagedChar === 'R' || stagedChar === 'C') {
      const parts = path.split(' -> ');
      if (parts.length === 2 && parts[0] && parts[1]) {
        staged.push({
          path: parts[1]!,
          status: stagedChar === 'R' ? 'renamed' : 'copied',
          oldPath: parts[0]
        });
      }
      continue;
    }

    // Handle untracked files
    if (stagedChar === '?' && unstagedChar === '?') {
      untracked.push(path);
      continue;
    }

    // Handle staged changes
    if (stagedChar !== ' ') {
      staged.push({
        path,
        status: parseFileStatus(stagedChar)
      });
    }

    // Handle unstaged changes
    if (unstagedChar !== ' ') {
      unstaged.push({
        path,
        status: parseFileStatus(unstagedChar)
      });
    }
  }

  return { staged, unstaged, untracked };
}

/**
 * Parse single character Git file status
 */
function parseFileStatus(char: string): GitFileStatus {
  switch (char) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'U': return 'unmerged';
    case ' ': return 'unmodified';
    default: return 'modified'; // Fallback
  }
}

/**
 * Parse git diff output
 */
export function parseGitDiff(output: string): DiffResult {
  const lines = output.split('\n');
  const files: DiffFile[] = [];
  const hunks: DiffHunk[] = [];

  let currentFile: Partial<DiffFile> | null = null;
  let currentHunk: Partial<DiffHunk> | null = null;
  let currentLines: DiffLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // File header: diff --git a/file b/file
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        files.push(currentFile as DiffFile);
      }
      if (currentHunk && currentLines.length > 0) {
        hunks.push({ ...currentHunk, lines: currentLines } as DiffHunk);
      }

      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
              const path2 = match?.[2] || '';
        const path1 = match?.[1] || '';
        currentFile = {
          path: path2,
          oldPath: path1 !== path2 ? path1 : undefined,
          status: 'modified',
          additions: 0,
          deletions: 0
        };
      currentHunk = null;
      currentLines = [];
      continue;
    }

    // Index line: index hash1..hash2 mode
    if (line.startsWith('index ')) {
      continue;
    }

    // File mode changes
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      continue;
    }

    // File status indicators
    if (line.startsWith('new file mode')) {
      if (currentFile) currentFile.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (currentFile) currentFile.status = 'deleted';
      continue;
    }

    // Binary file indicator
    if (line.includes('Binary files') && line.includes('differ')) {
      if (currentFile) currentFile.binary = true;
      continue;
    }

    // File paths (--- and +++)
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    // Hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    if (line.startsWith('@@')) {
      if (currentHunk && currentLines.length > 0) {
        hunks.push({ ...currentHunk, lines: currentLines } as DiffHunk);
      }

      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (match && match[1] && match[3]) {
        currentHunk = {
          file: currentFile?.path || '',
          oldStart: parseInt(match[1]),
          oldLines: parseInt(match[2] || '1'),
          newStart: parseInt(match[3]),
          newLines: parseInt(match[4] || '1'),
          header: line
        };
        currentLines = [];
      }
      continue;
    }

    // Diff content lines
    if (currentHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      const type = line[0] === '+' ? 'addition' : line[0] === '-' ? 'deletion' : 'context';
      const content = line.slice(1);
      const oldStart = currentHunk.oldStart || 0;
      const newStart = currentHunk.newStart || 0;

      currentLines.push({
        type,
        content,
        oldLineNumber: type !== 'addition' ? oldStart + currentLines.filter(l => l.type !== 'addition').length : undefined,
        newLineNumber: type !== 'deletion' ? newStart + currentLines.filter(l => l.type !== 'deletion').length : undefined
      });

      if (currentFile) {
        if (type === 'addition') currentFile.additions = (currentFile.additions || 0) + 1;
        if (type === 'deletion') currentFile.deletions = (currentFile.deletions || 0) + 1;
      }
    }
  }

  // Add final file and hunk
  if (currentFile) {
    files.push(currentFile as DiffFile);
  }
  if (currentHunk && currentLines.length > 0) {
    hunks.push({ ...currentHunk, lines: currentLines } as DiffHunk);
  }

  return { files, hunks };
}

/**
 * Parse git log --oneline output
 */
export function parseGitLog(output: string, format: 'oneline' | 'full' = 'full'): LogEntry[] {
  if (!output.trim()) return [];

  const lines = output.split('\n').filter(line => line.trim());
  const entries: LogEntry[] = [];

  if (format === 'oneline') {
    for (const line of lines) {
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
      if (match && match[1] && match[2]) {
        entries.push({
          sha: match[1],
          message: match[2],
          author: '',
          date: '',
          parents: []
        });
      }
    }
  } else {
    // Parse full format (commit, author, date, message)
    let currentEntry: Partial<LogEntry> | null = null;
    
    for (const line of lines) {
      if (line.startsWith('commit ')) {
        if (currentEntry) {
          entries.push(currentEntry as LogEntry);
        }
        const sha = line.slice(7).split(' ')[0];
        if (sha) {
          currentEntry = {
            sha,
            message: '',
            author: '',
            date: '',
            parents: [],
            refs: []
          };
        }
      } else if (line.startsWith('Author: ') && currentEntry) {
        currentEntry.author = line.slice(8);
      } else if (line.startsWith('Date: ') && currentEntry) {
        currentEntry.date = line.slice(6).trim();
      } else if (line.trim() && currentEntry && !line.startsWith(' ')) {
        // Commit message (typically indented)
        if (!currentEntry.message) {
          currentEntry.message = line.trim();
        }
      }
    }

    if (currentEntry) {
      entries.push(currentEntry as LogEntry);
    }
  }

  return entries;
}

/**
 * Parse git branch -v output
 */
export function parseGitBranches(output: string): BranchInfo[] {
  const lines = output.split('\n').filter(line => line.trim());
  const branches: BranchInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const current = trimmed.startsWith('* ');
    const cleanLine = current ? trimmed.slice(2) : trimmed;
    
    // Format: "branch-name sha commit-message"
    const parts = cleanLine.split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const name = parts[0];
      const sha = parts[1];
      
      branches.push({
        name,
        current,
        sha,
        ahead: 0,
        behind: 0
      });
    }
  }

  return branches;
}

/**
 * Parse git remote -v output
 */
export function parseGitRemotes(output: string): Remote[] {
  const lines = output.split('\n').filter(line => line.trim());
  const remotes: Remote[] = [];

  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (match && match[1] && match[2] && match[3]) {
      remotes.push({
        name: match[1],
        url: match[2],
        type: match[3] as 'fetch' | 'push'
      });
    }
  }

  return remotes;
}

/**
 * Parse git status -b --porcelain=v1 output for ahead/behind info
 */
export function parseAheadBehind(output: string): AheadBehind {
  const lines = output.split('\n');
  const branchLine = lines.find(line => line.startsWith('##'));
  
  if (!branchLine) {
    return { ahead: 0, behind: 0 };
  }

  // Format: ## branch...remote [ahead 2, behind 1]
  const match = branchLine.match(/\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]/);
  
  if (match) {
    const ahead = parseInt(match[1] || '0');
    const behind = parseInt(match[2] || match[3] || '0');
    return { ahead, behind };
  }

  return { ahead: 0, behind: 0 };
}

/**
 * Parse git stash list output
 */
export function parseGitStash(output: string): StashEntry[] {
  const lines = output.split('\n').filter(line => line.trim());
  const stashes: StashEntry[] = [];

  for (const line of lines) {
    // Format: stash@{0}: WIP on branch: commit-sha description
    const match = line.match(/^stash@\{(\d+)\}:\s+(.+?):\s+([a-f0-9]+)\s+(.+)$/);
    if (match && match[1] && match[2] && match[3] && match[4]) {
      stashes.push({
        index: parseInt(match[1]),
        description: match[4],
        branch: match[2].replace('WIP on ', ''),
        sha: match[3]
      });
    }
  }

  return stashes;
}

/**
 * Parse git rev-parse output for SHA resolution
 */
export function parseRevParse(output: string): string {
  return output.trim();
}

/**
 * Extract commit message components for conventional commits
 */
export function parseCommitMessage(message: string): { subject: string; body?: string; trailers: Array<{ key: string; value: string }> } {
  const lines = message.split('\n');
  const subject = lines[0] || '';
  
  // Find trailers (key: value pairs at the end)
  const trailers: Array<{ key: string; value: string }> = [];
  const bodyLines: string[] = [];
  
  let inTrailers = false;
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i];
    
    if (!line.trim()) {
      if (inTrailers) break;
      continue;
    }
    
    const trailerMatch = line.match(/^([A-Za-z-]+):\s*(.+)$/);
    if (trailerMatch && !inTrailers) {
      inTrailers = true;
      trailers.unshift({ key: trailerMatch[1], value: trailerMatch[2] });
    } else if (inTrailers) {
      break;
    } else {
      bodyLines.unshift(line);
    }
  }
  
  const body = bodyLines.join('\n').trim() || undefined;
  
  return { subject, body: body || undefined, trailers };
}
