use super::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0: u64 = 1_700_000_000_000;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

/// Set who calls, what they attach and the block time (ms after T0).
fn ctx(who: &str, deposit: NearToken, at_ms: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("market.test"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(deposit)
        .account_balance(near(1000))
        .block_timestamp((T0 + at_ms) * 1_000_000)
        .build());
}

fn input(price: u128) -> ListingInput {
    ListingInput {
        title: "Reel cutter".into(),
        summary: "Cuts your footage into a reel".into(),
        meta_hash: HASH.into(),
        price: near(price),
        accept_window_s: 60,
        delivery_window_s: 600,
        review_window_s: 120,
        intake_pubkey: "a2V5".into(),
    }
}

/// A market with one listing (id 0, 5 NEAR) by owner.test.
fn market() -> Market {
    ctx("admin.test", near(0), 0);
    let mut m = Market::new(acc("treasury.test"), 250, NearToken::from_millinear(100), near(1000), 2);
    ctx("owner.test", near(1), 0);
    assert_eq!(m.create_listing(input(5)), 0);
    m
}

fn placed(m: &mut Market) -> u64 {
    ctx("alice.test", near(5), 1_000);
    m.place_order(0, HASH.into(), Some("ed25519:abc".into()))
}

fn delivered(m: &mut Market) -> u64 {
    let id = placed(m);
    ctx("owner.test", near(0), 2_000);
    m.accept_order(id);
    ctx("owner.test", near(0), 3_000);
    m.deliver_order(id, HASH.into(), HASH2.into());
    id
}

/// yoctoNEAR sent to an account by the last call.
fn sent_to(who: &str) -> u128 {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id == acc(who))
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .sum()
}

#[test]
fn listing_is_stored_and_storage_is_charged() {
    let m = market();
    let l = m.get_listing(0).unwrap();
    assert_eq!(l.owner, acc("owner.test"));
    assert!(l.active);
    assert_eq!(l.price, near(5));
    assert_eq!(m.get_listings_by_owner(acc("owner.test")).len(), 1);
    // Most of the 1 NEAR attached for storage came back.
    let back = sent_to("owner.test");
    assert!(back > near(1).as_yoctonear() * 9 / 10 && back < near(1).as_yoctonear());
}

#[test]
#[should_panic(expected = "for storage")]
fn listing_needs_a_storage_deposit() {
    ctx("admin.test", near(0), 0);
    let mut m = Market::new(acc("treasury.test"), 250, near(1), near(1000), 2);
    ctx("owner.test", near(0), 0);
    m.create_listing(input(5));
}

#[test]
#[should_panic(expected = "the price must be between")]
fn price_cap_is_enforced() {
    let mut m = market();
    ctx("owner.test", near(1), 0);
    m.create_listing(input(5000));
}

#[test]
#[should_panic(expected = "only the listing's owner")]
fn only_the_owner_updates_a_listing() {
    let mut m = market();
    ctx("mallory.test", near(1), 0);
    m.update_listing(0, input(1));
}

#[test]
fn update_changes_the_price_for_new_orders_only() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(1), 1_500);
    m.update_listing(0, input(7));
    assert_eq!(m.get_listing(0).unwrap().price, near(7));
    assert_eq!(m.get_order(id).unwrap().price, near(5));
}

#[test]
#[should_panic(expected = "attach exactly the price")]
fn deposit_must_equal_the_price() {
    let mut m = market();
    ctx("alice.test", near(4), 1_000);
    m.place_order(0, HASH.into(), None);
}

#[test]
#[should_panic(expected = "takes no orders")]
fn inactive_listing_rejects_orders() {
    let mut m = market();
    ctx("owner.test", near(0), 500);
    m.set_active(0, false);
    ctx("alice.test", near(5), 1_000);
    m.place_order(0, HASH.into(), None);
}

#[test]
#[should_panic(expected = "open orders")]
fn open_orders_per_customer_are_capped() {
    let mut m = market();
    placed(&mut m);
    placed(&mut m);
    placed(&mut m);
}

#[test]
fn a_closed_order_frees_a_slot() {
    let mut m = market();
    let id = placed(&mut m);
    placed(&mut m);
    ctx("owner.test", near(0), 2_000);
    m.decline_order(id, Some("out of scope".into()));
    placed(&mut m);
    assert_eq!(m.get_orders_by_customer(acc("alice.test"), None, None).len(), 3);
    assert_eq!(m.get_orders(0, Some(1), Some(1))[0].id, 1);
}

#[test]
fn decline_refunds_with_a_reason() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(0), 2_000);
    m.decline_order(id, Some("out of scope".into()));
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Declined);
    assert_eq!(o.reason.as_deref(), Some("out of scope"));
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
    assert_eq!(m.get_listing(0).unwrap().stats.declined, 1);
}

#[test]
#[should_panic(expected = "only the listing's owner")]
fn only_the_owner_accepts() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("alice.test", near(0), 2_000);
    m.accept_order(id);
}

#[test]
#[should_panic(expected = "accept window is over")]
fn accept_after_the_window_is_refused() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(0), 1_000 + 61_000);
    m.accept_order(id);
}

#[test]
#[should_panic(expected = "still has time")]
fn expire_waits_for_the_window() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("bob.test", near(0), 30_000);
    m.expire_order(id);
}

#[test]
fn anyone_expires_an_unanswered_order() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("bob.test", near(0), 1_000 + 61_000);
    m.expire_order(id);
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Expired);
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
    assert_eq!(m.get_listing(0).unwrap().stats.expired, 1);
}

#[test]
fn anyone_expires_an_undelivered_order() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(0), 2_000);
    m.accept_order(id);
    ctx("bob.test", near(0), 2_000 + 601_000);
    m.expire_order(id);
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Expired);
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
}

#[test]
#[should_panic(expected = "delivery window is over")]
fn deliver_after_the_window_is_refused() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(0), 2_000);
    m.accept_order(id);
    ctx("owner.test", near(0), 2_000 + 601_000);
    m.deliver_order(id, HASH.into(), HASH2.into());
}

#[test]
fn fail_refunds_an_accepted_order() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(0), 2_000);
    m.accept_order(id);
    ctx("owner.test", near(0), 3_000);
    m.fail_order(id, Some("gates did not pass".into()));
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Failed);
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
    assert_eq!(m.get_listing(0).unwrap().stats.failed, 1);
}

#[test]
fn confirm_pays_the_owner_minus_the_fee() {
    let mut m = market();
    let id = delivered(&mut m);
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Delivered);
    assert_eq!(o.receipt_hash.as_deref(), Some(HASH));
    assert_eq!(o.bundle_hash.as_deref(), Some(HASH2));
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Settled);
    // 2.5% of 5 NEAR is 0.125 NEAR.
    assert_eq!(sent_to("treasury.test"), NearToken::from_millinear(125).as_yoctonear());
    assert_eq!(sent_to("owner.test"), NearToken::from_millinear(4875).as_yoctonear());
    assert_eq!(sent_to("alice.test"), 0);
    assert_eq!(m.get_listing(0).unwrap().stats.completed, 1);
}

#[test]
#[should_panic(expected = "only the customer")]
fn only_the_customer_confirms() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("owner.test", near(0), 4_000);
    m.confirm_order(id);
}

#[test]
#[should_panic(expected = "review window is still open")]
fn settle_waits_for_the_review_window() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("bob.test", near(0), 60_000);
    m.settle_order(id);
}

#[test]
fn anyone_settles_after_the_review_window() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("bob.test", near(0), 3_000 + 121_000);
    m.settle_order(id);
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Settled);
    assert_eq!(sent_to("owner.test"), NearToken::from_millinear(4875).as_yoctonear());
}

#[test]
fn dispute_refunds_and_counts_against_the_listing() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 10_000);
    m.dispute_order(id, Some("not what I ordered".into()));
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Disputed);
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
    assert_eq!(sent_to("owner.test"), 0);
    assert_eq!(m.get_listing(0).unwrap().stats.disputed, 1);
}

#[test]
#[should_panic(expected = "review window is over")]
fn dispute_after_the_window_is_refused() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 3_000 + 121_000);
    m.dispute_order(id, None);
}

#[test]
#[should_panic(expected = "only a delivered order")]
fn an_order_settles_once() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    ctx("alice.test", near(0), 5_000);
    m.confirm_order(id);
}

#[test]
fn the_fee_is_locked_when_the_order_is_placed() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("admin.test", near(0), 3_500);
    m.set_config(None, Some(1000), None, None, None);
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    assert_eq!(sent_to("treasury.test"), NearToken::from_millinear(125).as_yoctonear());
}

#[test]
#[should_panic(expected = "only the admin")]
fn only_the_admin_changes_the_configuration() {
    let mut m = market();
    ctx("owner.test", near(0), 0);
    m.set_config(None, Some(0), None, None, None);
}

#[test]
fn a_failed_transfer_becomes_claimable() {
    let mut m = market();
    ctx("market.test", near(0), 5_000);
    assert!(m.on_transfer(acc("alice.test"), near(5), Some(0), Ok(())));
    assert_eq!(m.get_claimable(acc("alice.test")), near(0));
    assert!(!m.on_transfer(acc("alice.test"), near(5), Some(0), Err(PromiseError::Failed)));
    assert_eq!(m.get_claimable(acc("alice.test")), near(5));
    ctx("alice.test", near(0), 6_000);
    let _ = m.claim();
    assert_eq!(m.get_claimable(acc("alice.test")), near(0));
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claim_needs_a_balance() {
    let mut m = market();
    ctx("alice.test", near(0), 6_000);
    let _ = m.claim();
}
