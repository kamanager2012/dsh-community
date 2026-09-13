/**
 * AEP — Agent Execution Protocol
 * ================================
 * 在 ACS 之上增加的"先计划再执行"协议层。
 *
 * Usage:
 *   import { AEP } from "./aep/index.js";
 *   const aep = new AEP();
 *   const review = aep.submitPlan({ planId: "p1", ... });
 *   if (review.status === "approved") { // execute }
 */

export { AEP } from "./execution-protocol.js";
export type { Plan, PlanReview, RiskLevel, ConfidenceLevel, PlanStatus } from "./execution-protocol.js";
