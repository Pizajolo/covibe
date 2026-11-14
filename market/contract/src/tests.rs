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
        revisions: None,
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

// ---- revisions

/// A market whose listing includes `n` revisions, with one delivered order.
fn delivered_with_revisions(n: u8) -> (Market, u64) {
    let mut m = market();
    ctx("owner.test", near(1), 0);
    m.update_listing(0, ListingInput { revisions: Some(n), ..input(5) });
    let id = delivered(&mut m);
    (m, id)
}

#[test]
fn an_included_revision_sends_the_team_back_at_once() {
    let (mut m, id) = delivered_with_revisions(1);
    assert_eq!(m.get_listing(0).unwrap().revisions, 1);
    ctx("alice.test", near(0), 10_000);
    assert!(m.request_revision(id, HASH2.into()));
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Accepted);
    assert_eq!(o.accepted_at, Some(T0 + 10_000));
    assert_eq!((o.revisions_included, o.revisions_used), (1, 1));
    assert_eq!(o.revision_hash.as_deref(), Some(HASH2));
    // The owner delivers again; the review window starts again.
    ctx("owner.test", near(0), 20_000);
    m.deliver_order(id, HASH2.into(), HASH.into());
    ctx("alice.test", near(0), 21_000);
    m.confirm_order(id);
    assert_eq!(m.get_order(id).unwrap().status, OrderStatus::Settled);
    assert_eq!(sent_to("owner.test"), near(5).as_yoctonear() * 9750 / 10_000);
}

#[test]
fn a_revision_beyond_the_included_ones_waits_for_the_owner() {
    let (mut m, id) = delivered_with_revisions(0);
    ctx("alice.test", near(0), 10_000);
    assert!(!m.request_revision(id, HASH2.into()));
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::RevisionRequested);
    assert_eq!(o.revision_requested_at, Some(T0 + 10_000));
    // Taken: the team goes back to work.
    ctx("owner.test", near(0), 11_000);
    m.answer_revision(id, true, None);
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Accepted);
    assert_eq!(o.revisions_used, 1);
}

#[test]
fn a_declined_revision_leaves_the_delivery_with_a_fresh_review_window() {
    let (mut m, id) = delivered_with_revisions(0);
    ctx("alice.test", near(0), 100_000);
    m.request_revision(id, HASH2.into());
    ctx("owner.test", near(0), 110_000);
    m.answer_revision(id, false, Some("out of scope".into()));
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Delivered);
    assert_eq!(o.delivered_at, Some(T0 + 110_000));
    assert_eq!(o.reason.as_deref(), Some("out of scope"));
    assert_eq!(o.revisions_used, 0);
    // The first window (120 s from 3 s) would be over by now; the fresh one is not.
    ctx("alice.test", near(0), 200_000);
    m.dispute_order(id, None);
    assert_eq!(sent_to("alice.test"), near(5).as_yoctonear());
}

#[test]
fn an_unanswered_revision_request_goes_back_to_delivered() {
    let (mut m, id) = delivered_with_revisions(0);
    ctx("alice.test", near(0), 10_000);
    m.request_revision(id, HASH2.into());
    // Nobody can settle while the request waits; the customer still can confirm or dispute.
    ctx("bob.test", near(0), 500_000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let (mut m2, id2) = delivered_with_revisions(0);
        ctx("alice.test", near(0), 10_000);
        m2.request_revision(id2, HASH2.into());
        ctx("bob.test", near(0), 500_000);
        m2.settle_order(id2);
    }))
    .is_err());
    ctx("bob.test", near(0), 500_000);
    m.expire_order(id);
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Delivered);
    assert_eq!(o.delivered_at, Some(T0 + 500_000));
    assert_eq!(sent_to("alice.test"), 0);
}

#[test]
#[should_panic(expected = "the owner still has time")]
fn a_revision_request_cannot_be_expired_early() {
    let (mut m, id) = delivered_with_revisions(0);
    ctx("alice.test", near(0), 10_000);
    m.request_revision(id, HASH2.into());
    ctx("bob.test", near(0), 20_000);
    m.expire_order(id);
}

#[test]
#[should_panic(expected = "the review window is over")]
fn a_revision_cannot_be_asked_for_after_the_review_window() {
    let (mut m, id) = delivered_with_revisions(1);
    ctx("alice.test", near(0), 200_000);
    m.request_revision(id, HASH2.into());
}

#[test]
#[should_panic(expected = "only the customer can ask for a revision")]
fn only_the_customer_asks_for_a_revision() {
    let (mut m, id) = delivered_with_revisions(1);
    ctx("bob.test", near(0), 10_000);
    m.request_revision(id, HASH2.into());
}

#[test]
#[should_panic(expected = "a listing can include 5 revisions at most")]
fn a_listing_cannot_include_more_than_five_revisions() {
    let mut m = market();
    ctx("owner.test", near(1), 0);
    m.update_listing(0, ListingInput { revisions: Some(6), ..input(5) });
}

#[test]
fn revisions_are_locked_when_the_order_is_placed() {
    let (mut m, id) = delivered_with_revisions(2);
    ctx("owner.test", near(1), 5_000);
    m.update_listing(0, ListingInput { revisions: Some(0), ..input(5) });
    assert_eq!(m.get_listing(0).unwrap().revisions, 0);
    assert_eq!(m.get_order(id).unwrap().revisions_included, 2);
}

// ---- reviews

#[test]
fn a_customer_reviews_a_settled_order_once() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    ctx("alice.test", near(0), 5_000);
    m.review_order(id, 4, Some("  Fast, and the reel was what I asked for.  ".into()));
    let l = m.get_listing(0).unwrap();
    assert_eq!((l.rating_count, l.rating_sum), (1, 4));
    let reviews = m.get_reviews(0, None, None);
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0].stars, 4);
    assert_eq!(reviews[0].comment, "Fast, and the reel was what I asked for.");
    assert_eq!(reviews[0].customer, acc("alice.test"));
    assert_eq!(m.get_order(id).unwrap().review.unwrap().stars, 4);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.review_order(id, 5, None))).is_err());
}

#[test]
fn a_disputed_order_can_be_reviewed_too() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 4_000);
    m.dispute_order(id, None);
    ctx("alice.test", near(0), 5_000);
    m.review_order(id, 1, None);
    assert_eq!(m.get_listing(0).unwrap().rating_sum, 1);
}

#[test]
#[should_panic(expected = "an order can be reviewed once it was delivered and is closed")]
fn an_open_order_cannot_be_reviewed() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 4_000);
    m.review_order(id, 5, None);
}

#[test]
#[should_panic(expected = "an order can be reviewed once it was delivered and is closed")]
fn a_declined_order_cannot_be_reviewed() {
    let mut m = market();
    let id = placed(&mut m);
    ctx("owner.test", near(0), 2_000);
    m.decline_order(id, None);
    ctx("alice.test", near(0), 3_000);
    m.review_order(id, 1, None);
}

#[test]
#[should_panic(expected = "only the customer can review an order")]
fn only_the_customer_reviews() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    ctx("bob.test", near(0), 5_000);
    m.review_order(id, 5, None);
}

#[test]
#[should_panic(expected = "give one to five stars")]
fn stars_are_one_to_five() {
    let mut m = market();
    let id = delivered(&mut m);
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    m.review_order(id, 6, None);
}

#[test]
fn views_carry_revisions_and_reviews_as_plain_fields() {
    let (m, id) = delivered_with_revisions(2);
    let listing = near_sdk::serde_json::to_value(m.get_listing(0).unwrap()).unwrap();
    assert_eq!(listing["title"], "Reel cutter");
    assert_eq!(listing["revisions"], 2);
    assert_eq!(listing["rating_count"], 0);
    let order = near_sdk::serde_json::to_value(m.get_order(id).unwrap()).unwrap();
    assert_eq!(order["status"], "DELIVERED");
    assert_eq!(order["revisions_included"], 2);
    assert!(order["review"].is_null());
}

#[test]
fn a_listing_input_without_revisions_still_parses() {
    let json = format!(r#"{{"title":"T","summary":"","meta_hash":"{HASH}","price":"1000000000000000000000000","accept_window_s":60,"delivery_window_s":60,"review_window_s":60,"intake_pubkey":"a2V5"}}"#);
    let l: ListingInput = near_sdk::serde_json::from_str(&json).unwrap();
    assert_eq!(l.revisions, None);
}

#[test]
fn migrate_carries_the_earlier_state_over() {
    let mut m = market();
    let id = delivered(&mut m);
    // The state as the first version stored it: the same fields, without the new maps.
    let Market { admin, treasury, fee_bps, min_price, max_price, max_open_orders, mut listings, mut orders, mut listing_orders, mut customer_orders, mut owner_listings, mut open_orders, mut claimable, .. } = m;
    listings.flush();
    orders.flush();
    listing_orders.flush();
    customer_orders.flush();
    owner_listings.flush();
    open_orders.flush();
    claimable.flush();
    env::state_write(&MarketV1 { admin, treasury, fee_bps, min_price, max_price, max_open_orders, listings, orders, listing_orders, customer_orders, owner_listings, open_orders, claimable });
    let mut m = Market::migrate();
    let o = m.get_order(id).unwrap();
    assert_eq!(o.status, OrderStatus::Delivered);
    assert_eq!(o.revisions_included, 0);
    assert_eq!(m.get_listing(0).unwrap().title, "Reel cutter");
    ctx("alice.test", near(0), 4_000);
    m.confirm_order(id);
    m.review_order(id, 5, None);
    assert_eq!(m.get_listing(0).unwrap().rating_count, 1);
}
