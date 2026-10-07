use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Transaction}

pub type MembershipAction {
  Issue { member: AssetName }
  Leave
}

validator membership(admin: VerificationKeyHash) {
  mint(redeemer: MembershipAction, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      Issue { member } -> and {
          bytearray.length(member) > 0,
          list.has(self.extra_signatories, admin),
          assets.quantity_of(self.mint, policy_id, member) == 1,
        }
      // Members may burn their own token to leave.
      Leave ->
        self.mint
          |> assets.tokens(policy_id)
          |> dict.values()
          |> list.all(fn(quantity) { quantity < 0 })
    }
  }

  else(_) {
    fail
  }
}
