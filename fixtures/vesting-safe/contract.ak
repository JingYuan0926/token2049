use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use cardano/transaction.{OutputReference, Transaction}

pub type VestingDatum {
  /// The party that locked the funds. It can cancel at any time.
  owner: VerificationKeyHash,
  /// The party that receives the funds after the lock ends.
  beneficiary: VerificationKeyHash,
  /// POSIX time in milliseconds.
  lock_until: Int,
}

pub type VestingAction {
  Claim
  Cancel
}

validator vesting {
  spend(
    datum: Option<VestingDatum>,
    redeemer: VestingAction,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(terms) = datum

    when redeemer is {
      Claim -> and {
          list.has(self.extra_signatories, terms.beneficiary),
          // The whole validity range must start after the lock ends.
          interval.is_entirely_after(self.validity_range, terms.lock_until),
        }

      Cancel -> list.has(self.extra_signatories, terms.owner)
    }
  }

  else(_) {
    fail
  }
}
