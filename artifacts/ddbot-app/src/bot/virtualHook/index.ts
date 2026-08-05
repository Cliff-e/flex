// =============================================================
// Virtual Hook v2 — Public API
//
// This is the single entry point for the Virtual Hook subsystem.
// Every trading engine imports from here.
// =============================================================

// Outputs
export { VHDecision } from './VHDecision';
export type { VHStartResult } from './VirtualHookEngine';

// Inputs
export type { TradeCandidate } from './TradeCandidate';
export { isTradeCandidate } from './TradeCandidate';

// Configuration
export type { VHConfig } from './VHConfig';
export { DEFAULT_VH_CONFIG, resolveVHConfig } from './VHConfig';

// Engine
export { VirtualHookEngine } from './VirtualHookEngine';

// State machine
export { VirtualStateMachine, VHState, VH_STATE_INFO } from './VirtualStateMachine';
export type { VHStateInfo } from './VirtualStateMachine';

// Contract model
export type { VirtualContract, VirtualSettlement, SettlementSource, VirtualContractStatus } from './VirtualContract';
export { VirtualContractFactory, estimateDurationMs, extractDigitValue } from './VirtualContract';

// Settlement — canonical settlement engine (functions)
export { settleDigitContract, isDigitContractWin, isDigitContract, DIGIT_CONTRACT_TYPES } from './SettlementEngine';
export type { SettlementResult } from './SettlementEngine';

// Policy
export { VirtualPolicy } from './VirtualPolicy';
export type { PolicyResult } from './VirtualPolicy';

// Adapters
export type { ProposalAdapter, VHProposal, ProposalResult } from './ProposalAdapter';
export type { TickObserver, VHTick } from './TickObserver';

// Transaction pipeline
export type { TransactionPipeline, TransactionRecord, TransactionResult } from './TransactionPipeline';
export { NoopTransactionPipeline } from './TransactionPipeline';

// Observability
export type { VHLogger, VHLogContext, VHLogEntry, VHLogLevel } from './VHLogger';
export { ConsoleVHLogger } from './VHLogger';

// Errors
export {
    VirtualHookError,
    InvalidTradeCandidateError,
    ProposalError,
    SettlementTimeoutError,
    VirtualHookBusyError,
    IllegalStateTransitionError,
} from './errors';