# cranberry-connectors

Exploring data access and exports from the systems we run on, starting with **Toast**. The goal is a
customer journey that spans orders and loyalty, keyed on whatever identifiers each system gives us.

## Setup

```bash
cp .env.example .env   # fill in Toast credentials
npm run toast:explore -- 30    # probe endpoints + pull the last 30 days of orders into data/toast/raw
npm run toast:journeys         # resolve customers, write data/toast/exports
```

Node 22+, no dependencies. `data/` is gitignored (it holds guest PII).

> Behind an HTTP proxy, run with `NODE_USE_ENV_PROXY=1` so Node's `fetch` honours `HTTPS_PROXY`.

## Layout

| Path | What |
| --- | --- |
| `src/toast/client.js` | Auth (machine client), retry on 429/5xx, pagination, day-by-day `ordersBulk` walker |
| `src/toast/identity.js` | Pull identifiers off checks, cluster them into customers, build profiles + journeys |
| `scripts/toast/explore.js` | Probes endpoints, dumps config and orders (`orders.jsonl`) |
| `scripts/toast/journeys.js` | Identity coverage report + exports (`customers.csv/json`, `journeys.jsonl`) |

## What Toast gives us (Standard API access, one location: Cranberry Resort)

**Reachable:** restaurant, config (dining options, revenue centers, service areas, tables, discounts,
tenders), labor/employees, menus, cash management, and orders (`/orders/v2/ordersBulk`, full detail).

**Not reachable:** there's no guest/CRM, loyalty-account, or gift card API on this access level. All
guest identity has to come from **what's embedded in orders**.

### Customer identifiers found on orders

| Identifier | Where | Fill rate (180 days, 41.7k checks) | Notes |
| --- | --- | --- | --- |
| Loyalty ID | `check.appliedLoyaltyInfo.loyaltyIdentifier` | 22.5% of checks | Toast Loyalty account. Stable across visits. Best key. |
| Customer GUID | `check.customer.guid` | 23.4% | Toast guest record. ~1:1 with loyalty ID. |
| Phone | `check.customer.phone` | 1.8% | Only when the guest typed it in. Always comes with a customer GUID. |
| Name | `check.customer.firstName/lastName` | ~2% | Often card placeholders ("Visa Cardholder") — filtered out. |
| Email | `check.customer.email` | 0% | Field exists, never populated in-store. |
| Card fingerprint | `payment.cardType + first6Digits + last4Digits` | 68.3% | BIN + last 4. Not globally unique but good within one venue. Links anonymous visits to known guests. |
| Tab name | `check.tabName` | ~25% | Free text from staff; pre-auth swipes produce `LAST, FIRST M` (parsed as a name hint). |
| Loyalty redemptions | `check.appliedDiscounts[].loyaltyDetails` | | e.g. "Cash Reward", `LOYALTY_DOLLARS_AMOUNTS` |

Not available: card token / PAN hash, guest email, delivery address (no delivery/online orders here,
almost all orders are `In Store`).

### How customers get resolved

1. Checks sharing a **strong** id (loyalty ID, customer GUID, phone, email) are merged.
   Ids that show up on more than one loyalty account (staff phone, shared house guest) are ignored.
2. **Card fingerprints** then merge further, except when that would join two different loyalty
   accounts (shared/company cards, couples) — those links are vetoed and counted.
3. Each cluster becomes a profile: ids, best name, first/last visit, visit days, spend, loyalty
   accrual/redemption, top items, and a chronological journey of checks.

Profiles are tagged `loyalty`, `contact`, `card` (card-only, no name/loyalty) or `anonymous` (cash, no ids).

### First run (2026-04-26 → 2026-10-23)

- 35,630 orders / 41,690 checks; 71.9% of checks carry at least one identifier (the rest are mostly cash).
- **2,687 loyalty guests**, 1,352 of them came back on 2+ days.
- Card linking ties **2,212 extra checks** to loyalty guests (visits where they paid with a known card
  but didn't scan loyalty) — 9,939 → 11,579 checks attributed.
- **13,170 card-only guests** (no loyalty), 1,994 of them repeat. Known by card, not by name — the
  biggest pool to convert to loyalty.
- 24 shared ids ignored and 83 card merges vetoed to avoid fusing different people.
