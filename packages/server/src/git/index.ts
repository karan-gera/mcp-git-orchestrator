/**
 * Git Module
 * 
 * Exports all Git-related functionality including safe execution,
 * output parsing, and type definitions.
 */

export { GitExecutor, gitExec, GitError } from './exec.js';
export * from './parse.js';
export * from '../types.js';
