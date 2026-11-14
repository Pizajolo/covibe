//! covibe market: listings, orders and escrow.
//!
//! A team owner publishes a listing. A customer places an order with the price
//! attached; the contract holds it until the order ends. The owner accepts or
//! declines, then delivers with the hashes of a signed receipt and the bundle.
//! The customer confirms or disputes inside the review window; when the window
//! ends anyone can settle. Every other way out of an order refunds the customer.
//!
//! Inside the review window the customer can also ask for a revision. A listing
//! names how many revisions per order it takes without asking (locked when the
//! order is placed); a request beyond those waits for the owner's answer. Once
//! an order that was delivered is closed, its customer can review it: one to
//! five stars and a comment, kept here so only real customers can write one.
//!
//! Money rules: state changes before any transfer, and a transfer that fails
//! is credited to the receiver's claimable balance (see `claim`) instead of
//! being lost.

use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// Windows are seconds, between 30 s (short enough for a demo) and 30 days.
const MIN_WINDOW_S: u32 = 30;
const MAX_WINDOW_S: u32 = 30 * 24 * 3600;
/// The fee can never be set above 10%.
const MAX_FEE_BPS: u16 = 1000;
const MAX_TITLE: usize = 100;
const MAX_SUMMARY: usize = 500;
const MAX_REASON: usize = 280;
const MAX_KEY: usize = 128;
const MAX_PAGE: u32 = 100;
const MAX_COMMENT: usize = 500;
/// Revisions a listing can promise without asking, and the most one order can go through.
const MAX_INCLUDED_REVISIONS: u8 = 5;
const MAX_REVISIONS: u8 = 10;
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Listings,
    Orders,
    ListingOrders,
    ListingOrdersOf { listing_id: u64 },
    CustomerOrders,
    CustomerOrdersOf { customer: AccountId },
    OwnerListings,
    OpenOrders,
    Claimable,
    IncludedRevisions,
    Revisions,
    Reviews,
    ListingReviews,
    ListingReviewsOf { listing_id: u64 },
    Ratings,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default, Debug, PartialEq)]
pub struct ListingStats {
    pub completed: u32,
    pub declined: u32,
    pub expired: u32,
    pub failed: u32,
    pub disputed: u32,
}

/// What an owner sets on a listing.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ListingInput {
    pub title: String,
    pub summary: String,
    /// sha256 (hex) of the listing page kept off-chain: examples and the input form.
    pub meta_hash: String,
    /// Fixed price of one order, in yoctoNEAR.
    pub price: NearToken,
    /// The owner must accept or decline within this many seconds.
    pub accept_window_s: u32,
    /// From accepting to delivering.
    pub delivery_window_s: u32,
    /// The customer's time to confirm or dispute before anyone can settle.
    pub review_window_s: u32,
    /// x25519 public key (base64) customers encrypt their order input to.
    pub intake_pubkey: String,
    /// Revisions per order that are taken without asking the owner (0 to 5; none when left out).
    #[serde(default)]
    pub revisions: Option<u8>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub id: u64,
    pub owner: AccountId,
    pub title: String,
    pub summary: String,
    pub meta_hash: String,
    pub price: NearToken,
    pub accept_window_s: u32,
    pub delivery_window_s: u32,
    pub review_window_s: u32,
    pub intake_pubkey: String,
    pub active: bool,
    pub stats: ListingStats,
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OrderStatus {
    Placed,
    Accepted,
    Delivered,
    Declined,
    Expired,
    Failed,
    Disputed,
    Settled,
    /// The customer asked for a revision that the owner has to answer.
    RevisionRequested,
}

/// An order's revisions. Kept beside the order, so orders stored before revisions existed still read.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Revisions {
    /// Taken without asking, locked from the listing when the order was placed.
    pub included: u8,
    /// Revisions the team was sent back for so far.
    pub used: u8,
    /// sha256 (hex) of the customer's latest revision note, encrypted in the relay.
    pub note_hash: Option<String>,
    /// When a request that waits for the owner was made.
    pub requested_at: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Review {
    pub order_id: u64,
    pub listing_id: u64,
    pub customer: AccountId,
    /// 1 to 5.
    pub stars: u8,
    pub comment: String,
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default)]
pub struct Rating {
    pub count: u32,
    /// The stars of all reviews added up; the average is sum / count.
    pub sum: u32,
}

/// A listing as the views return it: with its revisions and its rating.
#[near(serializers = [json])]
pub struct ListingView {
    #[serde(flatten)]
    pub listing: Listing,
    pub revisions: u8,
    pub rating_count: u32,
    pub rating_sum: u32,
}

/// An order as the views return it: with its revisions and its review.
#[near(serializers = [json])]
pub struct OrderView {
    #[serde(flatten)]
    pub order: Order,
    pub revisions_included: u8,
    pub revisions_used: u8,
    pub revision_hash: Option<String>,
    pub revision_requested_at: Option<u64>,
    pub review: Option<Review>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub listing_id: u64,
    pub customer: AccountId,
    /// The listing's owner when the order was placed (who is paid on settlement).
    pub owner: AccountId,
    /// Locked when the order was placed; a later price change does not touch it.
    pub price: NearToken,
    /// The platform fee in basis points, locked with the price.
    pub fee_bps: u16,
    /// sha256 (hex) of the encrypted input in the relay.
    pub input_hash: String,
    /// The customer's per-order ed25519 key (relay requests for this order are signed with it).
    pub access_key: Option<String>,
    pub status: OrderStatus,
    /// Milliseconds since the epoch (block time).
    pub created_at: u64,
    pub accepted_at: Option<u64>,
    pub delivered_at: Option<u64>,
    pub closed_at: Option<u64>,
    pub receipt_hash: Option<String>,
    pub bundle_hash: Option<String>,
    /// Why it was declined, failed or disputed.
    pub reason: Option<String>,
}

impl std::ops::Deref for ListingView {
    type Target = Listing;
    fn deref(&self) -> &Listing {
        &self.listing
    }
}

impl std::ops::Deref for OrderView {
    type Target = Order;
    fn deref(&self) -> &Order {
        &self.order
    }
}

#[near(serializers = [json])]
pub struct Config {
    pub admin: AccountId,
    pub treasury: AccountId,
    pub fee_bps: u16,
    pub min_price: NearToken,
    pub max_price: NearToken,
    pub max_open_orders: u32,
    pub listings: u64,
    pub orders: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    admin: AccountId,
    treasury: AccountId,
    fee_bps: u16,
    min_price: NearToken,
    max_price: NearToken,
    /// Orders one customer may have open (placed, accepted or delivered) at a time.
    max_open_orders: u32,
    listings: Vector<Listing>,
    orders: Vector<Order>,
    listing_orders: LookupMap<u64, Vector<u64>>,
    customer_orders: LookupMap<AccountId, Vector<u64>>,
    owner_listings: LookupMap<AccountId, Vec<u64>>,
    open_orders: LookupMap<AccountId, u32>,
    /// Transfers that failed, waiting to be claimed.
    claimable: LookupMap<AccountId, NearToken>,
    /// Listing → revisions per order taken without asking.
    included_revisions: LookupMap<u64, u8>,
    /// Order → its revisions.
    revisions: LookupMap<u64, Revisions>,
    /// Order → its review.
    reviews: LookupMap<u64, Review>,
    /// Listing → the orders that were reviewed, oldest first.
    listing_reviews: LookupMap<u64, Vector<u64>>,
    ratings: LookupMap<u64, Rating>,
}

/// The state before revisions and reviews (see `migrate`).
#[near(serializers = [borsh])]
pub struct MarketV1 {
    admin: AccountId,
    treasury: AccountId,
    fee_bps: u16,
    min_price: NearToken,
    max_price: NearToken,
    max_open_orders: u32,
    listings: Vector<Listing>,
    orders: Vector<Order>,
    listing_orders: LookupMap<u64, Vector<u64>>,
    customer_orders: LookupMap<AccountId, Vector<u64>>,
    owner_listings: LookupMap<AccountId, Vec<u64>>,
    open_orders: LookupMap<AccountId, u32>,
    claimable: LookupMap<AccountId, NearToken>,
}

#[near]
impl Market {
    #[init]
    pub fn new(treasury: AccountId, fee_bps: u16, min_price: NearToken, max_price: NearToken, max_open_orders: u32) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "the fee cannot be above 10%");
        require!(min_price <= max_price, "min_price is above max_price");
        require!(max_open_orders > 0, "max_open_orders must be at least 1");
        Self {
            admin: env::predecessor_account_id(),
            treasury,
            fee_bps,
            min_price,
            max_price,
            max_open_orders,
            listings: Vector::new(StorageKey::Listings),
            orders: Vector::new(StorageKey::Orders),
            listing_orders: LookupMap::new(StorageKey::ListingOrders),
            customer_orders: LookupMap::new(StorageKey::CustomerOrders),
            owner_listings: LookupMap::new(StorageKey::OwnerListings),
            open_orders: LookupMap::new(StorageKey::OpenOrders),
            claimable: LookupMap::new(StorageKey::Claimable),
            included_revisions: LookupMap::new(StorageKey::IncludedRevisions),
            revisions: LookupMap::new(StorageKey::Revisions),
            reviews: LookupMap::new(StorageKey::Reviews),
            listing_reviews: LookupMap::new(StorageKey::ListingReviews),
            ratings: LookupMap::new(StorageKey::Ratings),
        }
    }

    /// After upgrading the code of a contract deployed before revisions and reviews: carry its
    /// state over. Listings and orders stay as they are; old listings include no revisions.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: MarketV1 = env::state_read().unwrap_or_else(|| env::panic_str("there is no earlier state to migrate"));
        Self {
            admin: old.admin,
            treasury: old.treasury,
            fee_bps: old.fee_bps,
            min_price: old.min_price,
            max_price: old.max_price,
            max_open_orders: old.max_open_orders,
            listings: old.listings,
            orders: old.orders,
            listing_orders: old.listing_orders,
            customer_orders: old.customer_orders,
            owner_listings: old.owner_listings,
            open_orders: old.open_orders,
            claimable: old.claimable,
            included_revisions: LookupMap::new(StorageKey::IncludedRevisions),
            revisions: LookupMap::new(StorageKey::Revisions),
            reviews: LookupMap::new(StorageKey::Reviews),
            listing_reviews: LookupMap::new(StorageKey::ListingReviews),
            ratings: LookupMap::new(StorageKey::Ratings),
        }
    }

    // ---- platform ----

    /// Change the fee, the treasury or the caps. Orders already placed keep their fee.
    pub fn set_config(&mut self, treasury: Option<AccountId>, fee_bps: Option<u16>, min_price: Option<NearToken>, max_price: Option<NearToken>, max_open_orders: Option<u32>) {
        require!(env::predecessor_account_id() == self.admin, "only the admin can change the configuration");
        if let Some(t) = treasury {
            self.treasury = t;
        }
        if let Some(f) = fee_bps {
            require!(f <= MAX_FEE_BPS, "the fee cannot be above 10%");
            self.fee_bps = f;
        }
        if let Some(p) = min_price {
            self.min_price = p;
        }
        if let Some(p) = max_price {
            self.max_price = p;
        }
        require!(self.min_price <= self.max_price, "min_price is above max_price");
        if let Some(n) = max_open_orders {
            require!(n > 0, "max_open_orders must be at least 1");
            self.max_open_orders = n;
        }
    }

    pub fn get_config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            treasury: self.treasury.clone(),
            fee_bps: self.fee_bps,
            min_price: self.min_price,
            max_price: self.max_price,
            max_open_orders: self.max_open_orders,
            listings: self.listings.len() as u64,
            orders: self.orders.len() as u64,
        }
    }

    // ---- listings (owner) ----

    /// Publish a listing. Attach NEAR for its storage; what is not needed comes back.
    #[payable]
    pub fn create_listing(&mut self, listing: ListingInput) -> u64 {
        let before = env::storage_usage();
        self.check_listing(&listing);
        let owner = env::predecessor_account_id();
        let id = self.listings.len() as u64;
        self.listings.push(Listing {
            id,
            owner: owner.clone(),
            title: listing.title,
            summary: listing.summary,
            meta_hash: listing.meta_hash,
            price: listing.price,
            accept_window_s: listing.accept_window_s,
            delivery_window_s: listing.delivery_window_s,
            review_window_s: listing.review_window_s,
            intake_pubkey: listing.intake_pubkey,
            active: true,
            stats: ListingStats::default(),
            created_at: env::block_timestamp_ms(),
        });
        let mut mine = self.owner_listings.get(&owner).cloned().unwrap_or_default();
        mine.push(id);
        self.owner_listings.insert(owner, mine);
        self.listing_orders.insert(id, Vector::new(StorageKey::ListingOrdersOf { listing_id: id }));
        self.set_included_revisions(id, listing.revisions);
        self.charge_storage(before);
        event("listing_created", &format!(r#"{{"listing_id":{id}}}"#));
        id
    }

    /// Change a listing. Orders already placed keep their price.
    #[payable]
    pub fn update_listing(&mut self, listing_id: u64, listing: ListingInput) {
        let before = env::storage_usage();
        self.check_listing(&listing);
        let mut l = self.owned_listing(listing_id);
        l.title = listing.title;
        l.summary = listing.summary;
        l.meta_hash = listing.meta_hash;
        l.price = listing.price;
        l.accept_window_s = listing.accept_window_s;
        l.delivery_window_s = listing.delivery_window_s;
        l.review_window_s = listing.review_window_s;
        l.intake_pubkey = listing.intake_pubkey;
        self.listings.replace(listing_id as u32, l);
        self.set_included_revisions(listing_id, listing.revisions);
        self.charge_storage(before);
        event("listing_updated", &format!(r#"{{"listing_id":{listing_id}}}"#));
    }

    /// Open or close a listing for new orders.
    pub fn set_active(&mut self, listing_id: u64, active: bool) {
        let mut l = self.owned_listing(listing_id);
        l.active = active;
        self.listings.replace(listing_id as u32, l);
        event("listing_active", &format!(r#"{{"listing_id":{listing_id},"active":{active}}}"#));
    }

    // ---- orders ----

    /// Order from a listing. The attached deposit must equal the listing's price; the contract holds it.
    #[payable]
    pub fn place_order(&mut self, listing_id: u64, input_hash: String, access_key: Option<String>) -> u64 {
        let listing = self.listing(listing_id);
        require!(listing.active, "this listing takes no orders right now");
        require!(env::attached_deposit() == listing.price, format!("attach exactly the price: {} yoctoNEAR", listing.price.as_yoctonear()));
        require!(is_hash(&input_hash), "input_hash must be a sha256 in hex");
        if let Some(k) = &access_key {
            require!(!k.is_empty() && k.len() <= MAX_KEY, "access_key is too long");
        }
        let customer = env::predecessor_account_id();
        let open = self.open_orders.get(&customer).copied().unwrap_or(0);
        require!(open < self.max_open_orders, format!("you already have {open} open orders; wait for one to finish"));
        self.open_orders.insert(customer.clone(), open + 1);

        let id = self.orders.len() as u64;
        self.orders.push(Order {
            id,
            listing_id,
            customer: customer.clone(),
            owner: listing.owner,
            price: listing.price,
            fee_bps: self.fee_bps,
            input_hash,
            access_key,
            status: OrderStatus::Placed,
            created_at: env::block_timestamp_ms(),
            accepted_at: None,
            delivered_at: None,
            closed_at: None,
            receipt_hash: None,
            bundle_hash: None,
            reason: None,
        });
        self.listing_orders.get_mut(&listing_id).unwrap_or_else(|| env::panic_str("listing has no order index")).push(id);
        if !self.customer_orders.contains_key(&customer) {
            self.customer_orders.insert(customer.clone(), Vector::new(StorageKey::CustomerOrdersOf { customer: customer.clone() }));
        }
        self.customer_orders.get_mut(&customer).unwrap().push(id);
        let included = self.included_revisions.get(&listing_id).copied().unwrap_or(0);
        if included > 0 {
            self.revisions.insert(id, Revisions { included, ..Default::default() });
        }
        event("order_placed", &format!(r#"{{"order_id":{id},"listing_id":{listing_id},"customer":"{customer}"}}"#));
        id
    }

    /// The owner takes the order. The delivery window starts.
    pub fn accept_order(&mut self, order_id: u64) {
        let mut o = self.order_of_owner(order_id);
        require!(o.status == OrderStatus::Placed, "only a placed order can be accepted");
        let listing = self.listing(o.listing_id);
        require!(now() <= o.created_at + ms(listing.accept_window_s), "the accept window is over; the order can only expire");
        o.status = OrderStatus::Accepted;
        o.accepted_at = Some(now());
        self.orders.replace(order_id as u32, o);
        event("order_accepted", &format!(r#"{{"order_id":{order_id}}}"#));
    }

    /// The owner turns the order down. The customer is refunded at once.
    pub fn decline_order(&mut self, order_id: u64, reason: Option<String>) {
        let o = self.order_of_owner(order_id);
        require!(o.status == OrderStatus::Placed, "only a placed order can be declined");
        self.close_with_refund(o, OrderStatus::Declined, reason);
    }

    /// The owner gives up on an accepted order (a run that cannot succeed). The customer is refunded.
    pub fn fail_order(&mut self, order_id: u64, reason: Option<String>) {
        let o = self.order_of_owner(order_id);
        require!(o.status == OrderStatus::Accepted, "only an accepted order can be failed");
        self.close_with_refund(o, OrderStatus::Failed, reason);
    }

    /// The owner delivers: the hashes of the signed receipt and of the bundle in the relay. The review window starts.
    pub fn deliver_order(&mut self, order_id: u64, receipt_hash: String, bundle_hash: String) {
        let mut o = self.order_of_owner(order_id);
        require!(o.status == OrderStatus::Accepted, "only an accepted order can be delivered");
        require!(is_hash(&receipt_hash) && is_hash(&bundle_hash), "receipt_hash and bundle_hash must be sha256 in hex");
        let listing = self.listing(o.listing_id);
        require!(now() <= o.accepted_at.unwrap_or(0) + ms(listing.delivery_window_s), "the delivery window is over; the order can only expire");
        o.status = OrderStatus::Delivered;
        o.delivered_at = Some(now());
        o.receipt_hash = Some(receipt_hash);
        o.bundle_hash = Some(bundle_hash);
        self.orders.replace(order_id as u32, o);
        event("order_delivered", &format!(r#"{{"order_id":{order_id}}}"#));
    }

    /// The customer is happy with the delivery. The owner is paid.
    pub fn confirm_order(&mut self, order_id: u64) {
        let o = self.order(order_id);
        require!(env::predecessor_account_id() == o.customer, "only the customer can confirm");
        require!(o.status == OrderStatus::Delivered || o.status == OrderStatus::RevisionRequested, "only a delivered order can be confirmed");
        self.settle(o);
    }

    /// The customer rejects the delivery inside the review window. They are refunded and the
    /// dispute counts against the listing in public. There is no arbiter yet.
    pub fn dispute_order(&mut self, order_id: u64, reason: Option<String>) {
        let o = self.order(order_id);
        require!(env::predecessor_account_id() == o.customer, "only the customer can dispute");
        // While a revision request waits for the owner, the customer's clock is stopped.
        if o.status != OrderStatus::RevisionRequested {
            require!(o.status == OrderStatus::Delivered, "only a delivered order can be disputed");
            let listing = self.listing(o.listing_id);
            require!(now() <= o.delivered_at.unwrap_or(0) + ms(listing.review_window_s), "the review window is over");
        }
        self.close_with_refund(o, OrderStatus::Disputed, reason);
    }

    /// The customer asks for changes to a delivery, inside the review window. `note_hash` is the
    /// sha256 of the note, encrypted to the listing's intake key and kept in the relay. While the
    /// order has revisions included, the team goes back to work at once and the delivery window
    /// starts again; after that the request waits for the owner's answer. Returns whether it was
    /// taken at once.
    pub fn request_revision(&mut self, order_id: u64, note_hash: String) -> bool {
        let mut o = self.order(order_id);
        require!(env::predecessor_account_id() == o.customer, "only the customer can ask for a revision");
        require!(o.status == OrderStatus::Delivered, "a revision can be asked for once the order is delivered");
        require!(is_hash(&note_hash), "note_hash must be a sha256 in hex");
        let listing = self.listing(o.listing_id);
        require!(now() <= o.delivered_at.unwrap_or(0) + ms(listing.review_window_s), "the review window is over");
        let mut r = self.revisions.get(&order_id).cloned().unwrap_or_default();
        require!(r.used < MAX_REVISIONS, "this order has had as many revisions as an order can have");
        r.note_hash = Some(note_hash);
        let included = r.used < r.included;
        if included {
            r.used += 1;
            r.requested_at = None;
            o.status = OrderStatus::Accepted;
            o.accepted_at = Some(now());
        } else {
            r.requested_at = Some(now());
            o.status = OrderStatus::RevisionRequested;
        }
        let used = r.used;
        self.revisions.insert(order_id, r);
        self.orders.replace(order_id as u32, o);
        event("revision_requested", &format!(r#"{{"order_id":{order_id},"included":{included},"used":{used}}}"#));
        included
    }

    /// The owner answers a revision request. Taking it sends the team back to work and starts the
    /// delivery window again. Turning it down leaves the delivery as it is and gives the customer
    /// a fresh review window to confirm or dispute.
    pub fn answer_revision(&mut self, order_id: u64, accept: bool, reason: Option<String>) {
        let mut o = self.order_of_owner(order_id);
        require!(o.status == OrderStatus::RevisionRequested, "this order has no revision request waiting");
        let mut r = self.revisions.get(&order_id).cloned().unwrap_or_default();
        r.requested_at = None;
        if accept {
            r.used += 1;
            o.status = OrderStatus::Accepted;
            o.accepted_at = Some(now());
        } else {
            o.status = OrderStatus::Delivered;
            o.delivered_at = Some(now());
            o.reason = reason.map(|t| t.chars().take(MAX_REASON).collect());
        }
        self.revisions.insert(order_id, r);
        self.orders.replace(order_id as u32, o);
        event("revision_answered", &format!(r#"{{"order_id":{order_id},"accepted":{accept}}}"#));
    }

    /// The customer of an order that was delivered and is closed (settled or disputed) rates it:
    /// one to five stars and a comment. One review per order; it cannot be changed.
    pub fn review_order(&mut self, order_id: u64, stars: u8, comment: Option<String>) {
        let o = self.order(order_id);
        require!(env::predecessor_account_id() == o.customer, "only the customer can review an order");
        require!(o.closed_at.is_some() && o.delivered_at.is_some(), "an order can be reviewed once it was delivered and is closed");
        require!((1..=5).contains(&stars), "give one to five stars");
        require!(!self.reviews.contains_key(&order_id), "this order has a review already");
        let comment: String = comment.unwrap_or_default().trim().chars().take(MAX_COMMENT).collect();
        self.reviews.insert(order_id, Review { order_id, listing_id: o.listing_id, customer: o.customer, stars, comment, created_at: now() });
        if !self.listing_reviews.contains_key(&o.listing_id) {
            self.listing_reviews.insert(o.listing_id, Vector::new(StorageKey::ListingReviewsOf { listing_id: o.listing_id }));
        }
        self.listing_reviews.get_mut(&o.listing_id).unwrap().push(order_id);
        let mut rating = self.ratings.get(&o.listing_id).copied().unwrap_or_default();
        rating.count += 1;
        rating.sum += stars as u32;
        self.ratings.insert(o.listing_id, rating);
        event("order_reviewed", &format!(r#"{{"order_id":{order_id},"listing_id":{},"stars":{stars}}}"#, o.listing_id));
    }

    /// Anyone: refund an order the owner did not answer or deliver in time. A revision request
    /// the owner did not answer in the accept window goes back to delivered instead, with a fresh
    /// review window: the delivery stands, and the customer confirms or disputes it.
    pub fn expire_order(&mut self, order_id: u64) {
        let mut o = self.order(order_id);
        let listing = self.listing(o.listing_id);
        if o.status == OrderStatus::RevisionRequested {
            let mut r = self.revisions.get(&order_id).cloned().unwrap_or_default();
            require!(now() > r.requested_at.unwrap_or(0) + ms(listing.accept_window_s), "the owner still has time");
            r.requested_at = None;
            self.revisions.insert(order_id, r);
            o.status = OrderStatus::Delivered;
            o.delivered_at = Some(now());
            self.orders.replace(order_id as u32, o);
            event("revision_answered", &format!(r#"{{"order_id":{order_id},"accepted":false}}"#));
            return;
        }
        let late = match o.status {
            OrderStatus::Placed => now() > o.created_at + ms(listing.accept_window_s),
            OrderStatus::Accepted => now() > o.accepted_at.unwrap_or(0) + ms(listing.delivery_window_s),
            _ => env::panic_str("only a placed or accepted order can expire"),
        };
        require!(late, "the owner still has time");
        self.close_with_refund(o, OrderStatus::Expired, None);
    }

    /// Anyone: pay the owner once the review window ended without a dispute.
    pub fn settle_order(&mut self, order_id: u64) {
        let o = self.order(order_id);
        require!(o.status == OrderStatus::Delivered, "only a delivered order can be settled");
        let listing = self.listing(o.listing_id);
        require!(now() > o.delivered_at.unwrap_or(0) + ms(listing.review_window_s), "the customer's review window is still open");
        self.settle(o);
    }

    /// Take out NEAR a transfer to you failed to deliver.
    pub fn claim(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.claimable.get(&who).copied().unwrap_or(NearToken::from_yoctonear(0));
        require!(!amount.is_zero(), "nothing to claim");
        self.claimable.remove(&who);
        Promise::new(who.clone()).transfer(amount).then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(who, amount, None))
    }

    /// After a transfer: if it failed, the amount waits in the receiver's claimable balance.
    #[private]
    pub fn on_transfer(&mut self, to: AccountId, amount: NearToken, order_id: Option<u64>, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        let held = self.claimable.get(&to).copied().unwrap_or(NearToken::from_yoctonear(0));
        self.claimable.insert(to.clone(), held.saturating_add(amount));
        let order = order_id.map(|id| id.to_string()).unwrap_or_else(|| "null".to_string());
        event("transfer_failed", &format!(r#"{{"to":"{to}","amount":"{}","order_id":{order}}}"#, amount.as_yoctonear()));
        false
    }

    // ---- views ----

    pub fn get_listing(&self, listing_id: u64) -> Option<ListingView> {
        self.listings.get(listing_id as u32).map(|l| self.listing_view(l))
    }

    pub fn get_listings(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<ListingView> {
        let (from, limit) = page(from_index, limit);
        self.listings.iter().skip(from).take(limit).map(|l| self.listing_view(l)).collect()
    }

    pub fn get_listings_by_owner(&self, owner: AccountId) -> Vec<ListingView> {
        self.owner_listings.get(&owner).map(|ids| ids.iter().filter_map(|id| self.listings.get(*id as u32).map(|l| self.listing_view(l))).collect()).unwrap_or_default()
    }

    pub fn get_order(&self, order_id: u64) -> Option<OrderView> {
        self.orders.get(order_id as u32).map(|o| self.order_view(o))
    }

    /// A listing's reviews, oldest first.
    pub fn get_reviews(&self, listing_id: u64, from_index: Option<u64>, limit: Option<u32>) -> Vec<Review> {
        let (from, limit) = page(from_index, limit);
        self.listing_reviews.get(&listing_id).map(|ids| ids.iter().skip(from).take(limit).filter_map(|id| self.reviews.get(id).cloned()).collect()).unwrap_or_default()
    }

    /// A listing's orders, oldest first.
    pub fn get_orders(&self, listing_id: u64, from_index: Option<u64>, limit: Option<u32>) -> Vec<OrderView> {
        let (from, limit) = page(from_index, limit);
        self.listing_orders.get(&listing_id).map(|ids| self.orders_of(ids, from, limit)).unwrap_or_default()
    }

    /// A customer's orders, oldest first.
    pub fn get_orders_by_customer(&self, customer: AccountId, from_index: Option<u64>, limit: Option<u32>) -> Vec<OrderView> {
        let (from, limit) = page(from_index, limit);
        self.customer_orders.get(&customer).map(|ids| self.orders_of(ids, from, limit)).unwrap_or_default()
    }

    pub fn get_claimable(&self, account: AccountId) -> NearToken {
        self.claimable.get(&account).copied().unwrap_or(NearToken::from_yoctonear(0))
    }
}

impl Market {
    fn listing(&self, id: u64) -> Listing {
        self.listings.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no such listing"))
    }

    fn owned_listing(&self, id: u64) -> Listing {
        let l = self.listing(id);
        require!(env::predecessor_account_id() == l.owner, "only the listing's owner can do this");
        l
    }

    fn order(&self, id: u64) -> Order {
        self.orders.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no such order"))
    }

    fn order_of_owner(&self, id: u64) -> Order {
        let o = self.order(id);
        require!(env::predecessor_account_id() == o.owner, "only the listing's owner can do this");
        o
    }

    fn orders_of(&self, ids: &Vector<u64>, from: usize, limit: usize) -> Vec<OrderView> {
        ids.iter().skip(from).take(limit).filter_map(|id| self.orders.get(*id as u32).map(|o| self.order_view(o))).collect()
    }

    fn listing_view(&self, l: &Listing) -> ListingView {
        let rating = self.ratings.get(&l.id).copied().unwrap_or_default();
        ListingView { listing: l.clone(), revisions: self.included_revisions.get(&l.id).copied().unwrap_or(0), rating_count: rating.count, rating_sum: rating.sum }
    }

    fn order_view(&self, o: &Order) -> OrderView {
        let r = self.revisions.get(&o.id).cloned().unwrap_or_default();
        OrderView { order: o.clone(), revisions_included: r.included, revisions_used: r.used, revision_hash: r.note_hash, revision_requested_at: r.requested_at, review: self.reviews.get(&o.id).cloned() }
    }

    fn set_included_revisions(&mut self, listing_id: u64, revisions: Option<u8>) {
        let n = revisions.unwrap_or(0);
        require!(n <= MAX_INCLUDED_REVISIONS, "a listing can include 5 revisions at most");
        if n == 0 {
            self.included_revisions.remove(&listing_id);
        } else {
            self.included_revisions.insert(listing_id, n);
        }
    }

    fn check_listing(&self, l: &ListingInput) {
        require!(!l.title.trim().is_empty() && l.title.len() <= MAX_TITLE, "the title must have 1 to 100 characters");
        require!(l.summary.len() <= MAX_SUMMARY, "the summary can have 500 characters at most");
        require!(is_hash(&l.meta_hash), "meta_hash must be a sha256 in hex");
        require!(!l.intake_pubkey.is_empty() && l.intake_pubkey.len() <= MAX_KEY, "intake_pubkey is missing or too long");
        require!(l.price >= self.min_price && l.price <= self.max_price, format!("the price must be between {} and {} yoctoNEAR", self.min_price.as_yoctonear(), self.max_price.as_yoctonear()));
        for w in [l.accept_window_s, l.delivery_window_s, l.review_window_s] {
            require!((MIN_WINDOW_S..=MAX_WINDOW_S).contains(&w), "windows must be between 30 seconds and 30 days");
        }
    }

    /// The caller pays for the storage a call added; the rest of the deposit goes back.
    fn charge_storage(&mut self, before: u64) {
        self.listings.flush();
        self.listing_orders.flush();
        self.owner_listings.flush();
        self.included_revisions.flush();
        let used = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(used as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
    }

    fn close(&mut self, mut o: Order, status: OrderStatus, reason: Option<String>) -> Order {
        o.status = status;
        o.closed_at = Some(now());
        o.reason = reason.map(|r| r.chars().take(MAX_REASON).collect());
        self.orders.replace(o.id as u32, o.clone());
        let open = self.open_orders.get(&o.customer).copied().unwrap_or(0);
        if open <= 1 {
            self.open_orders.remove(&o.customer);
        } else {
            self.open_orders.insert(o.customer.clone(), open - 1);
        }
        let mut l = self.listing(o.listing_id);
        match status {
            OrderStatus::Settled => l.stats.completed += 1,
            OrderStatus::Declined => l.stats.declined += 1,
            OrderStatus::Expired => l.stats.expired += 1,
            OrderStatus::Failed => l.stats.failed += 1,
            OrderStatus::Disputed => l.stats.disputed += 1,
            _ => {}
        }
        self.listings.replace(o.listing_id as u32, l);
        o
    }

    fn close_with_refund(&mut self, o: Order, status: OrderStatus, reason: Option<String>) {
        let o = self.close(o, status, reason);
        let name = match status {
            OrderStatus::Declined => "order_declined",
            OrderStatus::Failed => "order_failed",
            OrderStatus::Disputed => "order_disputed",
            _ => "order_expired",
        };
        event(name, &format!(r#"{{"order_id":{},"refund":"{}"}}"#, o.id, o.price.as_yoctonear()));
        self.pay(o.customer, o.price, o.id);
    }

    fn settle(&mut self, o: Order) {
        let o = self.close(o, OrderStatus::Settled, None);
        let fee = NearToken::from_yoctonear(o.price.as_yoctonear() / 10_000 * o.fee_bps as u128 + o.price.as_yoctonear() % 10_000 * o.fee_bps as u128 / 10_000);
        let payout = o.price.saturating_sub(fee);
        event("order_settled", &format!(r#"{{"order_id":{},"payout":"{}","fee":"{}"}}"#, o.id, payout.as_yoctonear(), fee.as_yoctonear()));
        self.pay(o.owner, payout, o.id);
        self.pay(self.treasury.clone(), fee, o.id);
    }

    /// Send NEAR; if the transfer fails the amount becomes claimable (see on_transfer).
    fn pay(&mut self, to: AccountId, amount: NearToken, order_id: u64) {
        if amount.is_zero() {
            return;
        }
        Promise::new(to.clone()).transfer(amount).then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(to, amount, Some(order_id))).detach();
    }
}

fn now() -> u64 {
    env::block_timestamp_ms()
}

fn ms(seconds: u32) -> u64 {
    seconds as u64 * 1000
}

fn page(from_index: Option<u64>, limit: Option<u32>) -> (usize, usize) {
    (from_index.unwrap_or(0) as usize, limit.unwrap_or(50).min(MAX_PAGE) as usize)
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn event(name: &str, data: &str) {
    env::log_str(&format!(r#"EVENT_JSON:{{"standard":"covibe_market","version":"1.0.0","event":"{name}","data":[{data}]}}"#));
}

#[cfg(test)]
mod tests;
