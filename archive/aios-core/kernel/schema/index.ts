// AIOS Core — Shared types (kernel ↔ governor contract).
// These types are the public surface between layers.
//
// Industrial redesign principles:
//   1. Runtime is the ONLY state machine driver (SSOT)
//   2. All kernel functions are pure or stateless
//   3. IO is isolated behind adapters (ExecutionTier)
//   4. Reconciler is a pure reducer — no side effects, no ID generation

export type Phase =
  | "IDLE"
  | "PLAN"
  | "EXECUTE"
  | "VERIFY"
  | "COMMIT"
  | "DONE"
  | "ROLLBACK";

export type Approval = "AUTO" | "MANUAL";

export type Risk = "low" | "medium" | "high";

// ── Reliability Contract ───────────────────────────────────────────────────
// A TaskContract defines what evidence must exist before an execution may be
// accepted. It intentionally does not define how an agent should reason.

export type EvidenceKind =
  | "build"
  | "test"
  | "lint"
  | "e2e"
  | "diff"
  | "invariant"
  | "policy"
  | "artifact";

export type EvidenceStatus = "pass" | "fail" | "missing";

export interface EvidenceMetrics {
  passed?: number;
  failed?: number;
  total?: number;
}

export interface EvidenceItem {
  kind: EvidenceKind;
  // Stable requirement identifier for named evidence such as invariants or artifacts.
  id?: string;
  status: EvidenceStatus;
  summary: string;
  source?: string;
  metrics?: EvidenceMetrics;
}

export interface TaskContract {
  version: 1;
  requiredEvidence: EvidenceKind[];
  // Each named invariant requires matching kind="invariant", id=<name> evidence.
  invariants?: string[];
  acceptance?: {
    minTestsPassed?: number;
  };
}

export interface ReliabilityVerdict {
  status: "PASS" | "FAIL" | "INCOMPLETE";
  reasons: string[];
  missingEvidence: EvidenceKind[];
  failedEvidence: EvidenceKind[];
}

// ── Execution Tier ─────────────────────────────────────────────────────────
// Determines what IO operations are permitted.
// Tier 0 = dry-run (no IO), Tier 1 = shadow (IO but no commit), Tier 2 = production.

export type ExecutionTier = 0 | 1 | 2;

// ── Failure Taxonomy ───────────────────────────────────────────────────────
// Every failure in the system is classified into one of these categories.
// This makes failure a computable object rather than an opaque string.

export type FailureCategory =
  | "transient"       // network blip, timeout, temporary resource contention — safe to retry
  | "deterministic"   // logic bug, wrong code — retrying will produce the same result
  | "permission"      // scope rejection, approval denied, access denied
  | "corruption"      // data integrity violation, memory mismatch, snapshot inconsistency
  | "partial_success" // some steps succeeded, others failed — requires selective rollback
  | "resource"        // limits exceeded, out-of-memory, disk full
  | "unknown";        // unclassified — treated as deterministic (safe default)

export interface FailureRecord {
  category: FailureCategory;
  phase: Phase;
  message: string;
  recoverable: boolean;    // can the system automatically recover?
  maxRetries: number;      // how many retries are sensible for this category
  taskId: string;
  at: string;
  detail?: string | undefined;
}

// ── State Hash ─────────────────────────────────────────────────────────────
// Canonical fingerprint of runtime state at a point in time.
// Used for divergence detection and tamper verification.

export interface StateFingerprint {
  seq: number;                    // audit log seq this fingerprint covers
  hash: string;                   // SHA-256 hex digest of canonical state
  taskId: string;
  at: string;
}

// ── Project State ──────────────────────────────────────────────────────────

export interface ProjectState {
  goal: string;
  active_task: string | null;
  branch: string;
  phase: Phase;
  last_change: string;
  project?: string;
}

// ── Task Request ───────────────────────────────────────────────────────────

export interface TaskRequest {
  goal: string;
  project: string;
  context?: string;
  contract?: TaskContract;
}

// ── Plan ───────────────────────────────────────────────────────────────────

export interface PlanStep {
  order: number;
  action: string;
  target: string;
}

export interface Plan {
  task: string;
  scope: string[];
  risk: Risk;
  files: string[];
  steps: PlanStep[];
  tests: string[];
  rollback: string;
  approval: Approval;
  createdAt: string;
  frozen: boolean;
  contract?: TaskContract;
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface ExecutionResult {
  planId: string;
  diff: string;
  stagingPath: string;
  status: "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
  attempt: number; // which attempt this was (1-based)
}

// ── Verification ───────────────────────────────────────────────────────────

export interface VerificationReport {
  planId: string;
  status: "pass" | "fail";
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  logSummary: string;
  autoFixAttempts: number;
  evidence?: EvidenceItem[];
}

// ── Reconciliation ─────────────────────────────────────────────────────────

export type Decision = "COMMIT" | "ROLLBACK";

// Reconciler output: pure data, no IDs generated.
// Runtime assigns IDs when applying the decision.
export interface ReconciliationOutput {
  decision: Decision;
  memoryUpdate: MemoryUpdate;
  reason: string;
  reliabilityVerdict?: ReliabilityVerdict;
}

// ── Memory Updates ─────────────────────────────────────────────────────────
// These describe WHAT should happen, not HOW.
// Runtime decides whether and when to apply them.

export interface MemoryUpdate {
  current?: Partial<ProjectState>;
  appendTask?: Omit<MemoryTaskUpdate, "taskId"> & { taskId?: string | null };
  appendDecision?: Omit<MemoryDecisionUpdate, "id"> & { id?: string };
  appendIncident?: Omit<MemoryIncidentUpdate, "id"> & { id?: string };
}

export interface MemoryTaskUpdate {
  taskId: string | null;
  status: string;
  decision: string;
  at: string;
}

export interface MemoryDecisionUpdate {
  id: string;
  decision: string;
  reason: string;
  at: string;
}

export interface MemoryIncidentUpdate {
  id: string;
  taskId: string | null;
  reason: string;
  at: string;
}


export interface InvariantViolation {
  invariant: string;
  message: string;
  taskId: string;
  phase: Phase | "IDLE";
  transition?: PhaseTransition | undefined;
  state: string; // serialized snapshot of relevant state
}

export interface PhaseTransition {
  from: Phase | "IDLE";
  to: Phase;
  taskId: string;
  note?: string;
}

export interface RuntimeState {
  taskId: string;
  request: TaskRequest;
  transitions: PhaseTransition[];
  plan: Plan | null;
  execResult: ExecutionResult | null;
  verifyReport: VerificationReport | null;
  decision: Decision | null;
  memoryUpdate: MemoryUpdate | null;
  memoryCommitted: boolean;
  memoryRolledBack: boolean;
  terminal: boolean;
  reason: string;
  limitsUsed: { turns: number; context: number; retries: number };
  totalRetries: number;
  totalAutoFixAttempts: number;
  invariantViolations: InvariantViolation[];
  failureRecord: FailureRecord | null;
  lastFingerprint?: string;
  hashChainLength: number;
}
