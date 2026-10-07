// Pure checks on an MPS resolve result (includeHistory 'true') for the paid Task stages.

/** @param {any} tx */
const isConfirmedTx = tx => tx?.status === 'Confirmed' && /^[0-9a-f]{64}$/.test(tx.txHash ?? '') && (tx.confirmations ?? 0) >= 1;

/** A confirmed transaction that moved the payment into `state`. @param {any} resolved @param {string} state */
function confirmedTxFor(resolved, state) {
  const current = resolved?.CurrentTransaction;
  if (isConfirmedTx(current) && (current.newOnChainState == null || current.newOnChainState === state)) return current;
  const history = Array.isArray(resolved?.TransactionHistory) ? resolved.TransactionHistory : [];
  return history.find(tx => isConfirmedTx(tx) && tx.newOnChainState === state) ?? null;
}

/** The buyer's funds sit in escrow with at least one confirmation. Paid work may start. @param {any} resolved */
export function isFundsLockedConfirmed(resolved) {
  return resolved?.onChainState === 'FundsLocked' && confirmedTxFor(resolved, 'FundsLocked') !== null;
}

/** MPS will accept submit-result now. @param {any} resolved */
export function canSubmitResult(resolved) {
  return isFundsLockedConfirmed(resolved) && resolved.NextAction?.requestedAction === 'WaitingForExternalAction' &&
    resolved.NextAction?.errorType == null && !resolved.resultHash && resolved.NextAction?.resultHash == null;
}

/** MPS took this hash (queued or on chain). Do not submit it a second time. @param {any} resolved @param {string} hash */
export function isResultAccepted(resolved, hash) {
  return typeof hash === 'string' && hash !== '' && (resolved?.resultHash === hash || resolved?.NextAction?.resultHash === hash);
}

/** The result hash is on chain with a confirmed transaction. @param {any} resolved @param {string} hash */
export function isResultSubmittedConfirmed(resolved, hash) {
  return typeof hash === 'string' && hash !== '' && resolved?.onChainState === 'ResultSubmitted' &&
    resolved.resultHash === hash && confirmedTxFor(resolved, 'ResultSubmitted') !== null;
}

/** The seller collected (ordinary withdrawal, confirmed). @param {any} resolved */
export function isWithdrawn(resolved) {
  return resolved?.onChainState === 'Withdrawn' && confirmedTxFor(resolved, 'Withdrawn') !== null;
}

/** Withdrawal tx hash, to match against the Core receipt txHash. @param {any} resolved */
export function withdrawalTxHash(resolved) {
  return isWithdrawn(resolved) ? confirmedTxFor(resolved, 'Withdrawn').txHash : null;
}

/** D13: check this after every async read and right before the paid model call. @param {any} quote @param {number} [now] */
export function resultDeadlinePassed(quote, now = Date.now()) {
  const deadline = Number(quote?.submitResultTime);
  return !Number.isSafeInteger(deadline) || deadline <= 0 || now >= deadline;
}
