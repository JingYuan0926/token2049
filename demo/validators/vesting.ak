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

const owner_key = #"aa00000000000000000000000000000000000000000000000000000a"

const beneficiary_key = #"bb00000000000000000000000000000000000000000000000000000b"

const terms_value =
  VestingDatum { owner: owner_key, beneficiary: beneficiary_key, lock_until: 1000 }

fn tx_with(signers, range) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    extra_signatories: signers,
    validity_range: range,
  }
}

fn run(action, signers, range) -> Bool {
  vesting.spend(
    Some(terms_value),
    action,
    OutputReference(#"01", 0),
    tx_with(signers, range),
  )
}

test claim_after_lock() {
  run(Claim, [beneficiary_key], interval.after(1001))
}

test claim_at_lock_inclusive_rejected() fail {
  run(Claim, [beneficiary_key], interval.after(1000))
}

test claim_before_lock_rejected() fail {
  run(Claim, [beneficiary_key], interval.after(999))
}

test claim_unbounded_rejected() fail {
  run(Claim, [beneficiary_key], interval.everything)
}

test claim_wide_range_rejected() fail {
  run(Claim, [beneficiary_key], interval.between(0, 5000))
}

test claim_without_signature_rejected() fail {
  run(Claim, [owner_key], interval.after(5000))
}

test cancel_by_owner() {
  run(Cancel, [owner_key], interval.everything)
}

test cancel_by_beneficiary_rejected() fail {
  run(Cancel, [beneficiary_key], interval.everything)
}
