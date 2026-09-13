/**
 * ACS — Agent Constraint System
 * ==============================
 * 入口文件。导出所有约束和引擎。
 *
 * 使用方式:
 *   import { ScopeEnforcer, PatchConstraint } from "./index.js";
 *   const enforcer = new ScopeEnforcer();
 *   enforcer.setScope({ taskId: "...", allowedFiles: ["src/**"], ... });
 *   enforcer.checkFile("/project/src/foo.ts");  // true
 */

export { ScopeEnforcer } from "./constraint/scope-constraint.js";
export { PatchConstraint } from "./patch/patch.js";
export { PatchClassifier } from "./patch/classifier.js";
export { PatchTransactionSystem } from "./patch/transaction.js";
export { PathFreeze } from "./constraint/path-freeze.js";
export { WriteBudget } from "./constraint/write-budget.js";
export { FileIntegrity } from "./integrity/manifest.js";
export { ASTGuard } from "./integrity/ast-guard.js";
export { SourceLock } from "./integrity/source-lock.js";
export { Pipeline } from "./runtime/pipeline.js";
export { ApprovalGate } from "./runtime/approval-gate.js";
export { AgentFreeze } from "./runtime/agent-freeze.js";
export { WorkspaceSnapshot } from "./runtime/workspace-snapshot.js";
export { RollbackEngine } from "./runtime/rollback.js";
export { SemanticGuard } from "./integrity/semantic-guard.js";
export { appendViolation, readViolations, violationSummary } from "./audit/violation-log.js";

// 类型导出 — RiskLevel 统一从 classifier 导出（classifier 与 approval-gate 一致）
export type { RiskLevel } from "./patch/classifier.js";
export type { PipelineResult } from "./runtime/pipeline.js";
export type { ApprovalRequest } from "./runtime/approval-gate.js";
export type { DegradationReport, DegradationIssue, DegradationType } from "./integrity/semantic-guard.js";
export type { PatchClassification, ClassifiedChange, ChangeType } from "./patch/classifier.js";
export type { PatchTransaction, TransactionStatus } from "./patch/transaction.js";
export type { ScopeConfig, Violation, ViolationState } from "./constraint/scope-constraint.js";
export type { Patch, PatchHunk, PatchLine, PatchValidation } from "./patch/patch.js";
export type { BudgetConfig, BudgetState } from "./constraint/write-budget.js";
export type { FileFingerprint } from "./integrity/manifest.js";
export type { ASTSnapshot, ASTDiff, FunctionSig } from "./integrity/ast-guard.js";
export type { SourceRecord, SourceVerification } from "./integrity/source-lock.js";
