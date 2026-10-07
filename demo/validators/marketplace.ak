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

validator marketplace {
  spend(
    datum: Option<Listing>,
    redeemer: Action,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(listing) = datum

    when redeemer is {
      // The buyer pays the seller the listed price and takes the item.
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

      // Only the seller can take the item back.
      Cancel -> list.has(self.extra_signatories, listing.seller)
    }
  }

  else(_) {
    fail
  }
}

const seller_key = #"aa00000000000000000000000000000000000000000000000000000a"

const buyer_key = #"cc00000000000000000000000000000000000000000000000000000c"

fn payment_tx(lovelace: Int, signers: List<VerificationKeyHash>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    extra_signatories: signers,
    outputs: [
      transaction.Output {
        address: address.from_verification_key(seller_key),
        value: assets.from_lovelace(lovelace),
        datum: transaction.NoDatum,
        reference_script: None,
      },
    ],
  }
}

const listing = Listing { seller: seller_key, price: 100_000_000 }

test buy_with_full_payment() {
  marketplace.spend(
    Some(listing),
    Buy,
    OutputReference(#"01", 0),
    payment_tx(100_000_000, [buyer_key]),
  )
}

test underpaid_buy_fails() fail {
  marketplace.spend(
    Some(listing),
    Buy,
    OutputReference(#"01", 0),
    payment_tx(99_000_000, [buyer_key]),
  )
}

test seller_can_cancel() {
  marketplace.spend(
    Some(listing),
    Cancel,
    OutputReference(#"01", 0),
    payment_tx(0, [seller_key]),
  )
}

test buyer_cannot_cancel() fail {
  marketplace.spend(
    Some(listing),
    Cancel,
    OutputReference(#"01", 0),
    payment_tx(0, [buyer_key]),
  )
}
