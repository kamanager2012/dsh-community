// governor-core — public API.
//
// Agent-agnostic governance core: normalize a tool call, get a deterministic
// allow/deny/ask verdict, and record it to a tamper-evident audit chain.
// Adapters (e.g. the Claude Code hook) live under src/adapters and translate
// a native payload into the ToolCall contract exported here.

export type {
  ToolCall,
  Verdict,
  Decision,
  Mode,
  Risk,
  Plan,
  PlanStep,
  ApprovalToken,
  AuditEvent,
} from "./types.js";

export { GovernanceEngine, type EngineConfig } from "./engine.js";
export {
  ScopeValidator,
  DEFAULT_POLICY,
  globMatch,
  stripQuoted,
  expandAssignments,
  stripAssignments,
  extractWriteTargets,
  type ScopePolicy,
} from "./scope.js";
export {
  loadPolicy,
  validatePolicy,
  mergeWithDefault,
  makeValidator,
  type PolicyLoadResult,
} from "./policy.js";
export {
  AuditLog,
  FileAuditSink,
  InMemoryAuditSink,
  readChain,
  verifyChain,
  hashRecord,
  writeAnchor,
  readAnchors,
  verifyAgainstAnchor,
  type AuditSink,
  type ChainedRecord,
  type ChainVerification,
  type Anchor,
  type AnchorVerification,
} from "./audit.js";
export {
  ApprovalStore,
  signatureId,
  defaultApprovalDir,
  DEFAULT_TOKEN_TTL_MS,
  type PendingRequest,
  type GrantedToken,
} from "./approval.js";
