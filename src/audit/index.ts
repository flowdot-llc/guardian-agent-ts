export { AuditLogWriter } from './writer.js';
export type { AuditLogWriterOptions } from './writer.js';
export { AuditLogReader } from './reader.js';
export {
  GENESIS_HASH,
  computeRecordHash,
  canonicalJsonStringify,
  canonicalizeForHash,
} from './chain.js';
export {
  generateEd25519KeyPair,
  loadPrivateKey,
  loadPublicKey,
  signRecord,
  verifyRecord,
  SIGNATURE_PREFIX,
} from './signature.js';
export type { Ed25519KeyPair } from './signature.js';
export {
  httpAttestor,
  nullAttestor,
  payloadFromRecord,
} from './attestor.js';
export type {
  Attestor,
  AttestationPayload,
  AttestationReceipt,
  HttpAttestorOptions,
} from './attestor.js';
export {
  analyzeAgent,
  analyzeMultiAgent,
  compareToBaseline,
  mean,
  stddev,
} from './stats.js';
export type {
  AgentProfile,
  Deviation,
  DeviationReport,
  CompareOptions,
} from './stats.js';
export {
  correlate,
  summarizeSessions,
  findOverlappingSessions,
  findArgsHashCollisions,
  findSequenceSimilarity,
} from './correlation.js';
export type {
  AuditSource,
  SessionSummary,
  CorrelationMatch,
  CorrelationOptions,
} from './correlation.js';
