use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use cardano/transaction.{OutputReference, Transaction, ValidityRange}

pub type VestingDatum {
  owner: VerificationKeyHash,
  beneficiary: VerificationKeyHash,
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
    expect Some(schedule) = datum
    when redeemer is {
      Claim -> is_unlocked(self.validity_range, schedule.lock_until)
      Cancel -> and {
          list.has(self.extra_signatories, schedule.owner),
          is_still_locked(self.validity_range, schedule.lock_until),
        }
    }
  }

  else(_) {
    fail
  }
}

// The whole validity range must start at or after the unlock time.
fn is_unlocked(range: ValidityRange, lock_until: Int) -> Bool {
  when range.lower_bound.bound_type is {
    Finite(earliest) -> lock_until <= earliest
    _ -> False
  }
}

// The whole validity range must end before the unlock time.
fn is_still_locked(range: ValidityRange, lock_until: Int) -> Bool {
  when range.upper_bound.bound_type is {
    Finite(latest) -> latest < lock_until
    _ -> False
  }
}
