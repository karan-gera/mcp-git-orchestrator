/**
 * Conflict Map Tool Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConflictMapTool } from '../conflict_map.js';
import { gitExec } from '../../git/index.js';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

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

// Import the mocked parser
import { parseGitStatus } from '../../git/index.js';
const mockParseGitStatus = vi.mocked(parseGitStatus);

describe('ConflictMapTool', () => {
  let tool: ConflictMapTool;
  let tempDir: string;
  const mockGitExec = vi.mocked(gitExec);

  beforeEach(async () => {
    tool = new ConflictMapTool();
    vi.clearAllMocks();
    
    // Create temporary directory for test files
    tempDir = join(tmpdir(), `conflict-map-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    
    // Setup default mocks
    mockGitExec.isValidRepository.mockResolvedValue(true);
    mockParseGitStatus.mockReturnValue({
      staged: [
        { path: 'src/conflicted.ts', status: 'unmerged' }
      ],
      unstaged: [],
      untracked: []
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getDescription', () => {
    it('returns correct description', () => {
      expect(tool.getDescription()).toBe('Analyze Git conflict markers and provide resolution guidance with priority ordering');
    });
  });

  describe('getInputSchema', () => {
    it('returns valid JSON schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('files');
      expect(schema.properties).toHaveProperty('include_suggestions');
      expect(schema.properties).toHaveProperty('include_content');
    });
  });

  describe('execute', () => {
    it('returns error when not in a git repository', async () => {
      mockGitExec.isValidRepository.mockResolvedValue(false);

      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a Git repository');
    });

    it('returns success when no conflicts found', async () => {
      mockParseGitStatus.mockReturnValue({
        staged: [],
        unstaged: [],
        untracked: []
      });

      const result = await tool.execute({});

      expect(result.success).toBe(true);
      expect(result.data.totalConflicts).toBe(0);
      expect(result.data.conflictedFiles).toHaveLength(0);
      expect(result.summary).toBe('No conflicts found');
    });

    it('analyzes files with simple conflicts', async () => {
      // Create a file with simple conflict
      const conflictContent = `function test() {
<<<<<<< HEAD
  return "our version";
=======
  return "their version";
>>>>>>> feature-branch
}`;
      
      const testFile = join(tempDir, 'src', 'conflicted.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, conflictContent);

      const result = await tool.execute({
        files: ['src/conflicted.ts']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      expect(result.data.totalConflicts).toBe(1);
      expect(result.data.conflictedFiles).toHaveLength(1);
      
      const conflictFile = result.data.conflictedFiles[0];
      expect(conflictFile.path).toBe('src/conflicted.ts');
      expect(conflictFile.conflicts).toHaveLength(1);
      
      const conflict = conflictFile.conflicts[0];
      expect(conflict.startLine).toBe(2);
      expect(conflict.endLine).toBe(6);
      expect(conflict.separatorLine).toBe(4);
      expect(conflict.oursBranch).toBe('HEAD');
      expect(conflict.theirsBranch).toBe('feature-branch');
      expect(conflict.complexity).toBe('low');
    });

    it('analyzes files with multiple conflicts', async () => {
      // Create a file with multiple conflicts
      const conflictContent = `function first() {
<<<<<<< HEAD
  return "our first";
=======
  return "their first";
>>>>>>> feature-branch
}

function second() {
<<<<<<< HEAD
  return "our second";
  console.log("additional line");
=======
  return "their second";
  console.log("different line");
  console.log("extra line");
>>>>>>> feature-branch
}`;
      
      const testFile = join(tempDir, 'src', 'multiple-conflicts.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, conflictContent);

      const result = await tool.execute({
        files: ['src/multiple-conflicts.ts']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      expect(result.data.totalConflicts).toBe(2);
      
      const conflictFile = result.data.conflictedFiles[0];
      expect(conflictFile.conflicts).toHaveLength(2);
      expect(conflictFile.conflicts[0].complexity).toBe('low');
      expect(conflictFile.conflicts[1].complexity).toBe('medium'); // More lines
    });

    it('includes content when requested', async () => {
      const conflictContent = `function test() {
<<<<<<< HEAD
  return "our version";
  console.log("debug");
=======
  return "their version";
  console.log("different debug");
>>>>>>> feature-branch
}`;
      
      const testFile = join(tempDir, 'src', 'content-test.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, conflictContent);

      const result = await tool.execute({
        files: ['src/content-test.ts'],
        include_content: true,
        content_limit: 3
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      
      const conflict = result.data.conflictedFiles[0].conflicts[0];
      expect(conflict.oursLines).toEqual([
        '  return "our version";',
        '  console.log("debug");'
      ]);
      expect(conflict.theirsLines).toEqual([
        '  return "their version";',
        '  console.log("different debug");'
      ]);
    });

    it('generates proper resolution order by priority', async () => {
      // Create multiple files with different priorities
      const packageConflict = `{
  "name": "test",
<<<<<<< HEAD
  "version": "1.0.0"
=======
  "version": "1.1.0"
>>>>>>> feature-branch
}`;

      const sourceConflict = `function test() {
<<<<<<< HEAD
  return "our version";
=======
  return "their version";
>>>>>>> feature-branch
}`;

      const testConflict = `describe('test', () => {
<<<<<<< HEAD
  it('should work our way', () => {
=======
  it('should work their way', () => {
>>>>>>> feature-branch
    expect(true).toBe(true);
  });
});`;

      await mkdir(join(tempDir, 'src'), { recursive: true });
      await mkdir(join(tempDir, '__tests__'), { recursive: true });
      
      await writeFile(join(tempDir, 'package.json'), packageConflict);
      await writeFile(join(tempDir, 'src', 'main.ts'), sourceConflict);
      await writeFile(join(tempDir, '__tests__', 'main.test.ts'), testConflict);

      const result = await tool.execute({
        files: ['package.json', 'src/main.ts', '__tests__/main.test.ts']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      expect(result.data.conflictedFiles).toHaveLength(3);
      
      // package.json should have highest priority (critical file)
      expect(result.data.resolutionOrder[0]).toBe('package.json');
      expect(result.data.resolutionOrder).toContain('src/main.ts');
      expect(result.data.resolutionOrder).toContain('__tests__/main.test.ts');
    });

    it('generates appropriate resolution suggestions', async () => {
      // Create a file with many conflicts
      let conflictContent = 'const values = {\n';
      for (let i = 0; i < 8; i++) {
        conflictContent += `<<<<<<< HEAD
  value${i}: "our${i}",
=======
  value${i}: "their${i}",
>>>>>>> feature-branch
`;
      }
      conflictContent += '};';

      const testFile = join(tempDir, 'src', 'many-conflicts.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, conflictContent);

      const result = await tool.execute({
        files: ['src/many-conflicts.ts'],
        include_suggestions: true
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      expect(result.data.suggestions.length).toBeGreaterThan(0);
      
      // Should suggest handling high conflict density
      const highDensitySuggestion = result.data.suggestions.find(s => 
        s.title.includes('High Conflict Density')
      );
      expect(highDensitySuggestion).toBeDefined();
      expect(highDensitySuggestion?.priority).toBe('high');
    });

    it('calculates conflict complexity correctly', async () => {
      const complexConflict = `function complex() {
<<<<<<< HEAD
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  const i = 9;
  const j = 10;
  const k = 11;
  const l = 12;
  const m = 13;
  const n = 14;
  const o = 15;
  const p = 16;
  return a + b + c + d + e + f + g + h + i + j + k + l + m + n + o + p;
=======
  const x = 1;
  const y = 2;
  const z = 3;
  const w = 4;
  const v = 5;
  const u = 6;
  const t = 7;
  const s = 8;
  const r = 9;
  const q = 10;
  const pp = 11;
  const oo = 12;
  const nn = 13;
  const mm = 14;
  const ll = 15;
  const kk = 16;
  return x + y + z + w + v + u + t + s + r + q + pp + oo + nn + mm + ll + kk;
>>>>>>> feature-branch
}`;

      const testFile = join(tempDir, 'src', 'complex.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, complexConflict);

      const result = await tool.execute({
        files: ['src/complex.ts']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      
      const conflict = result.data.conflictedFiles[0].conflicts[0];
      expect(conflict.complexity).toBe('high');
    });

    it('handles files without conflicts gracefully', async () => {
      const cleanContent = `function clean() {
  return "no conflicts here";
}`;

      const testFile = join(tempDir, 'src', 'clean.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, cleanContent);

      const result = await tool.execute({
        files: ['src/clean.ts']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      expect(result.data.totalConflicts).toBe(0);
      expect(result.data.conflictedFiles).toHaveLength(0);
    });

    it('filters suggestions by priority', async () => {
      const packageConflict = `{
<<<<<<< HEAD
  "name": "our-package"
=======
  "name": "their-package"
>>>>>>> feature-branch
}`;

      await writeFile(join(tempDir, 'package.json'), packageConflict);

      const result = await tool.execute({
        files: ['package.json'],
        include_suggestions: true
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      
      // Should have suggestions including critical file warning
      const criticalSuggestion = result.data.suggestions.find(s => 
        s.title.includes('Critical File')
      );
      expect(criticalSuggestion).toBeDefined();
      expect(criticalSuggestion?.priority).toBe('high');
    });

    it('generates meaningful summary messages', async () => {
      const conflictContent = `function test() {
<<<<<<< HEAD
  return "our version";
=======
  return "their version";
>>>>>>> feature-branch
}`;
      
      const testFile = join(tempDir, 'src', 'test.ts');
      await mkdir(join(tempDir, 'src'), { recursive: true });
      await writeFile(testFile, conflictContent);

      const result = await tool.execute({
        files: ['src/test.ts']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Found 1 conflicts in 1 file');
    });
  });

  describe('conflict marker detection', () => {
    it('detects standard Git conflict markers', async () => {
      const conflictContent = `line1
<<<<<<< HEAD
our content
=======
their content  
>>>>>>> branch-name
line2`;

      const testFile = join(tempDir, 'test.txt');
      await writeFile(testFile, conflictContent);

      const result = await tool.execute({
        files: ['test.txt']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      const conflict = result.data.conflictedFiles[0].conflicts[0];
      expect(conflict.startLine).toBe(2);
      expect(conflict.separatorLine).toBe(4);
      expect(conflict.endLine).toBe(6);
    });

    it('handles malformed conflict markers gracefully', async () => {
      const malformedContent = `line1
<<<<<<< HEAD
our content
line without separator
>>>>>>> branch-name
line2`;

      const testFile = join(tempDir, 'malformed.txt');
      await writeFile(testFile, malformedContent);

      const result = await tool.execute({
        files: ['malformed.txt']
      }, { repositoryPath: tempDir });

      expect(result.success).toBe(true);
      // Should handle malformed conflicts gracefully
      expect(result.data.totalConflicts).toBe(0);
    });
  });
});
