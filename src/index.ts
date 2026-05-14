/**
 * @flowdot-llc/guardian-agent — public API surface.
 * SPEC: see flowdot-llc/guardian-agent/SPEC.md (v0.2.0).
 */

export const VERSION = '0.1.0' as const;
export { SPEC_VERSION } from './types.js';

// runtime
export { GuardianRuntime } from './runtime/runtime.js';
export type { GuardianRuntimeOptions, ToolOptions } from './runtime/runtime.js';
export {
  defineHoneytokenSet,
  matchPhantomTool,
  matchHoneytokenInArgs,
  checkHoneytoken,
} from './runtime/honeytokens.js';
export type { Honeytoken, HoneytokenSet, HoneytokenHit } from './runtime/honeytokens.js';
export { CapabilityWindow } from './runtime/capability.js';
export type {
  CapabilityClass,
  CapabilityRule,
  CapabilityEvent,
  CapabilityMatch,
  CapabilityWindowOptions,
} from './runtime/capability.js';
export { MultiRateLimiter, DEFAULT_BUCKETS } from './runtime/multi-rate-limiter.js';
export type {
  BucketConfig,
  MultiRateLimiterOptions,
  ConsumeAllowed,
  ConsumeDenied,
  ConsumeResult,
} from './runtime/multi-rate-limiter.js';

// audit
export {
  AuditLogWriter,
  AuditLogReader,
  GENESIS_HASH,
  computeRecordHash,
  canonicalJsonStringify,
  canonicalizeForHash,
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
  signRecord,
  verifyRecord,
  SIGNATURE_PREFIX,
  httpAttestor,
  nullAttestor,
  payloadFromRecord,
  analyzeAgent,
  analyzeMultiAgent,
  compareToBaseline,
  mean,
  stddev,
  correlate,
  summarizeSessions,
  findOverlappingSessions,
  findArgsHashCollisions,
  findSequenceSimilarity,
} from './audit/index.js';
export type {
  AuditLogWriterOptions,
  Ed25519KeyPair,
  Attestor,
  AttestationPayload,
  AttestationReceipt,
  HttpAttestorOptions,
  AgentProfile,
  Deviation,
  DeviationReport,
  CompareOptions,
  AuditSource,
  SessionSummary,
  CorrelationMatch,
  CorrelationOptions,
} from './audit/index.js';

// estop
export { EStopLocal } from './estop/local.js';
export type { EStopLocalOptions } from './estop/local.js';
export { HeartbeatMonitor } from './estop/heartbeat.js';
export type { HeartbeatMonitorOptions } from './estop/heartbeat.js';
export type {
  EStopState,
  EStopPressOptions,
  EStopClearOptions,
  EStopPressResult,
  EStopClearResult,
} from './estop/types.js';

// gate option sets (custom + the FlowDot defaults)
export {
  CLASSIC_FOUR,
  FLOWDOT_FIVE,
  defineGateOptionSet,
  findOption,
  resolveOption,
} from './gate/options.js';
export type { GateOption, GateOptionSet } from './gate/options.js';

// two-key operator authorization (v0.9 / SPEC §4.5)
export {
  callbackOperatorGate,
  denyAllOperatorGate,
  newGateId,
  awaitWithTimeout,
} from './gate/two-key.js';
export type {
  OperatorConfirmationGate,
  OperatorConfirmationRequest,
  OperatorConfirmationResponse,
} from './gate/two-key.js';

// policy attribution path matching (model/provider/aggregator/surface globs)
export {
  flatGlobMatch,
  matchAttributionPath,
  renderAttributionPath,
  ATTRIBUTION_MISSING_SEGMENT,
} from './policy/attribution.js';
export type { PolicyWhen } from './policy/types.js';

// notify
export type { Notifier, NotificationEvent, NotificationKind } from './notify/types.js';
export { consoleNotifier, webhookNotifier, multiNotifier } from './notify/index.js';
export type {
  ConsoleNotifierOptions,
  WebhookNotifierOptions,
  MultiNotifierOptions,
} from './notify/index.js';

// shared
export type {
  ModelAttribution,
  AuditRecord,
  AuditRecordKind,
  AuditRecordStatus,
  AuditRecordInitiator,
} from './types.js';

// errors
export {
  GuardianHaltedError,
  GuardianConfigError,
  GuardianIntegrityError,
} from './errors.js';
