/**
 * Base Tool Tests
 */

import { describe, it, expect } from 'vitest';
import { createSuccessResult, createErrorResult, BaseTool, type ToolResult, type ToolContext } from '../base.js';

// Test implementation of BaseTool
class TestTool extends BaseTool {
  constructor() {
    super('test-tool');
  }

  getDescription(): string {
    return 'Test tool for unit testing';
  }

  getInputSchema() {
    return {
      type: 'object',
      properties: {
        test_param: { type: 'string' }
      }
    };
  }

  async execute(args: any, context?: ToolContext): Promise<ToolResult> {
    if (args.shouldFail) {
      return createErrorResult('Test error');
    }
    
    return createSuccessResult(
      { result: 'test data' },
      'Test successful',
      { repositoryPath: this.getRepositoryPath(context) }
    );
  }
}

describe('Base Tool Utilities', () => {
  describe('createSuccessResult', () => {
    it('creates success result with required fields', () => {
      const data = { key: 'value' };
      const summary = 'Operation successful';
      
      const result = createSuccessResult(data, summary);
      
      expect(result.success).toBe(true);
      expect(result.data).toEqual(data);
      expect(result.summary).toBe(summary);
      expect(result.error).toBeUndefined();
    });

    it('includes metadata when provided', () => {
      const data = { key: 'value' };
      const summary = 'Operation successful';
      const metadata = { extra: 'info' };
      
      const result = createSuccessResult(data, summary, metadata);
      
      expect(result.metadata).toEqual(metadata);
    });
  });

  describe('createErrorResult', () => {
    it('creates error result with required fields', () => {
      const error = 'Something went wrong';
      
      const result = createErrorResult(error);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
      expect(result.summary).toBe('Error: Something went wrong');
      expect(result.data).toBeNull();
    });

    it('includes data and metadata when provided', () => {
      const error = 'Something went wrong';
      const data = { partial: 'data' };
      const metadata = { debug: 'info' };
      
      const result = createErrorResult(error, data, metadata);
      
      expect(result.data).toEqual(data);
      expect(result.metadata).toEqual(metadata);
    });
  });
});

describe('BaseTool', () => {
  let tool: TestTool;

  beforeEach(() => {
    tool = new TestTool();
  });

  describe('constructor', () => {
    it('sets the tool name', () => {
      expect((tool as any).name).toBe('test-tool');
    });
  });

  describe('getRepositoryPath', () => {
    it('returns process.cwd() when no context provided', () => {
      const path = (tool as any).getRepositoryPath();
      expect(path).toBe(process.cwd());
    });

    it('returns repositoryPath from context when provided', () => {
      const context = { repositoryPath: '/custom/repo/path' };
      const path = (tool as any).getRepositoryPath(context);
      expect(path).toBe('/custom/repo/path');
    });

    it('returns cwd from context when repositoryPath not provided', () => {
      const context = { cwd: '/working/directory' };
      const path = (tool as any).getRepositoryPath(context);
      expect(path).toBe('/working/directory');
    });

    it('prioritizes repositoryPath over cwd', () => {
      const context = { 
        repositoryPath: '/repo/path',
        cwd: '/working/directory' 
      };
      const path = (tool as any).getRepositoryPath(context);
      expect(path).toBe('/repo/path');
    });
  });

  describe('execute', () => {
    it('returns success result for normal execution', async () => {
      const result = await tool.execute({});
      
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'test data' });
      expect(result.summary).toBe('Test successful');
    });

    it('returns error result when operation fails', async () => {
      const result = await tool.execute({ shouldFail: true });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
      expect(result.summary).toBe('Error: Test error');
    });

    it('includes repository path in metadata', async () => {
      const context = { repositoryPath: '/test/repo' };
      const result = await tool.execute({}, context);
      
      expect(result.metadata?.repositoryPath).toBe('/test/repo');
    });
  });

  describe('getDescription', () => {
    it('returns the tool description', () => {
      expect(tool.getDescription()).toBe('Test tool for unit testing');
    });
  });

  describe('getInputSchema', () => {
    it('returns the input schema', () => {
      const schema = tool.getInputSchema();
      
      expect(schema).toHaveProperty('type', 'object');
      expect(schema).toHaveProperty('properties');
      expect(schema.properties).toHaveProperty('test_param');
    });
  });
});
