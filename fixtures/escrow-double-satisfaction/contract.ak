use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address
use cardano/assets
use cardano/transaction.{OutputReference, Transaction}

/// A fixed-price sale. The seller locks an item with this datum.
pub type Listing {
  seller: VerificationKeyHash,
  /// Price in lovelace.
  price: Int,
}

pub type Action {
  Buy
  Cancel
}

validator escrow {
  spend(
    datum: Option<Listing>,
    redeemer: Action,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(listing) = datum

    when redeemer is {
      Buy -> {
        let seller_address = address.from_verification_key(listing.seller)
        list.any(
          self.outputs,
          fn(output) {
            and {
              output.address == seller_address,
              assets.lovelace_of(output.value) >= listing.price,
            }
          },
        )
      }

      Cancel -> list.has(self.extra_signatories, listing.seller)
    }
  }

  else(_) {
    fail
  }
}
