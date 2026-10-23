// Extract guest identifiers from Toast orders and resolve them into customers.
//
// Identifier strength (what Toast actually gives us):
//   loyalty   - check.appliedLoyaltyInfo.loyaltyIdentifier (Toast Loyalty account, stable across visits)
//   customer  - check.customer.guid (Toast guest record; ~1:1 with loyalty account)
//   phone     - check.customer.phone (only when the guest typed it in)
//   email     - check.customer.email
//   card      - payment brand + first6 (BIN) + last4. Not globally unique, but within one venue it is a
//               good fingerprint. Weaker: only merges clusters when it doesn't contradict a strong id.

const PLACEHOLDER_NAMES = /^(visa|mastercard|amex|discover|card ?holder|null|undefined|na)$/i;

export const STRONG = ['loyalty', 'customer', 'phone', 'email'];

export function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

export function cleanName(...parts) {
  const words = parts
    .flatMap((p) => String(p ?? '').split(/\s+/))
    .filter((w) => w && !PLACEHOLDER_NAMES.test(w));
  return words.length ? words.join(' ') : null;
}

/** Tab names from pre-auth swipes look like "BAIRD, DONALD J" -> "Donald J Baird". */
function nameFromTab(tab) {
  if (!tab) return null;
  const m = tab.match(/^([A-Z'-]+),\s*([A-Z][A-Z .'-]*)$/);
  if (!m) return null;
  const title = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return `${title(m[2].trim())} ${title(m[1])}`;
}

export function cardFingerprint(p) {
  return p.last4Digits ? `${p.cardType ?? 'UNKNOWN'}:${p.first6Digits ?? '------'}:${p.last4Digits}` : null;
}

/** One row per (non-voided) check: the unit a guest actually pays for. */
export function extractChecks(orders) {
  const rows = [];
  for (const order of orders) {
    if (order.voided || order.deleted) continue;
    for (const check of order.checks ?? []) {
      if (check.voided || check.deleted) continue;
      const payments = (check.payments ?? []).filter((p) => !p.voidInfo && p.paymentStatus !== 'VOIDED');
      const cust = check.customer ?? {};
      const ids = {
        loyalty: check.appliedLoyaltyInfo?.loyaltyIdentifier ?? null,
        customer: cust.guid ?? null,
        phone: normalizePhone(cust.phone),
        email: cust.email?.trim().toLowerCase() || null,
        cards: [...new Set(payments.map(cardFingerprint).filter(Boolean))],
      };
      const loyaltyRedemptions = (check.appliedDiscounts ?? [])
        .filter((d) => d.loyaltyDetails)
        .map((d) => ({ name: d.name, amount: d.discountAmount, referenceId: d.loyaltyDetails.referenceId }));

      rows.push({
        checkGuid: check.guid,
        orderGuid: order.guid,
        businessDate: order.businessDate,
        openedDate: check.openedDate,
        closedDate: check.closedDate,
        source: order.source,
        diningOption: order.diningOption?.guid ?? null,
        revenueCenter: order.revenueCenter?.guid ?? null,
        serviceArea: order.serviceArea?.guid ?? null,
        table: order.table?.guid ?? null,
        server: order.server?.guid ?? null,
        guests: order.numberOfGuests,
        amount: check.amount,
        total: check.totalAmount,
        tip: payments.reduce((s, p) => s + (p.tipAmount ?? 0), 0),
        paymentTypes: [...new Set(payments.map((p) => p.type))],
        items: (check.selections ?? [])
          .filter((s) => !s.voided)
          .map((s) => ({ name: s.displayName, qty: s.quantity, price: s.price })),
        loyaltyRedemptions,
        loyaltyAccrued: !!ids.loyalty,
        names: [cleanName(cust.firstName, cust.lastName), nameFromTab(check.tabName)].filter(Boolean),
        tabName: check.tabName ?? null,
        ids,
      });
    }
  }
  return rows;
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    for (let n = x; n !== root;) { const next = this.parent.get(n); this.parent.set(n, root); n = next; }
    return root;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(rb, ra); return ra; }
}

/**
 * Cluster checks into customers.
 * Pass 1 links checks that share a strong identifier.
 * Pass 2 links by card fingerprint, but refuses a merge that would put two different loyalty
 * accounts in one customer (shared/company cards, couples splitting the bill, etc).
 * Identifiers seen on too many distinct people (e.g. a staff phone) are ignored.
 */
export function resolveCustomers(checks, { maxLoyaltyPerKey = 1 } = {}) {
  const uf = new UnionFind();
  const key = (type, value) => `${type}:${value}`;
  checks.forEach((c) => uf.find(c.checkGuid));

  // Ignore strong identifiers that span multiple loyalty accounts: those are shared, not personal.
  const loyaltyByKey = new Map();
  for (const c of checks) {
    for (const type of ['customer', 'phone', 'email']) {
      const v = c.ids[type];
      if (!v || !c.ids.loyalty) continue;
      const k = key(type, v);
      if (!loyaltyByKey.has(k)) loyaltyByKey.set(k, new Set());
      loyaltyByKey.get(k).add(c.ids.loyalty);
    }
  }
  const shared = new Set([...loyaltyByKey].filter(([, s]) => s.size > maxLoyaltyPerKey).map(([k]) => k));

  for (const c of checks) {
    for (const type of STRONG) {
      const v = c.ids[type];
      if (v && !shared.has(key(type, v))) uf.union(c.checkGuid, key(type, v));
    }
  }

  // Loyalty accounts per cluster, used to veto card merges.
  const loyaltyOf = new Map();
  for (const c of checks) {
    if (!c.ids.loyalty) continue;
    const r = uf.find(c.checkGuid);
    if (!loyaltyOf.has(r)) loyaltyOf.set(r, new Set());
    loyaltyOf.get(r).add(c.ids.loyalty);
  }
  const vetoed = [];
  for (const c of checks) {
    for (const card of c.ids.cards) {
      const a = uf.find(c.checkGuid), b = uf.find(key('card', card));
      if (a === b) continue;
      const la = loyaltyOf.get(a), lb = loyaltyOf.get(b);
      if (la && lb && ![...la].some((x) => lb.has(x))) { vetoed.push({ card, checkGuid: c.checkGuid }); continue; }
      const r = uf.union(a, b);
      if (la || lb) loyaltyOf.set(r, new Set([...(la ?? []), ...(lb ?? [])]));
    }
  }

  const clusters = new Map();
  for (const c of checks) {
    const r = uf.find(c.checkGuid);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(c);
  }
  return { clusters: [...clusters.values()], sharedIdentifiers: [...shared], vetoedCardLinks: vetoed };
}

const mostCommon = (arr) => {
  const counts = new Map();
  arr.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** Turn a cluster of checks into a customer profile + chronological journey. */
export function buildProfile(cluster) {
  const visits = [...cluster].sort((a, b) => (a.openedDate ?? '').localeCompare(b.openedDate ?? ''));
  const collect = (fn) => [...new Set(visits.flatMap(fn).filter(Boolean))];
  const ids = {
    loyalty: collect((v) => v.ids.loyalty),
    customer: collect((v) => v.ids.customer),
    phone: collect((v) => v.ids.phone),
    email: collect((v) => v.ids.email),
    cards: collect((v) => v.ids.cards),
  };
  const strength = ids.loyalty.length || ids.customer.length ? 'loyalty'
    : ids.phone.length || ids.email.length ? 'contact'
    : ids.cards.length ? 'card' : 'anonymous';
  const days = [...new Set(visits.map((v) => v.businessDate))].sort();
  const spend = visits.reduce((s, v) => s + (v.total ?? 0), 0);
  const itemCounts = new Map();
  visits.flatMap((v) => v.items).forEach((i) => itemCounts.set(i.name, (itemCounts.get(i.name) ?? 0) + (i.qty ?? 1)));

  return {
    customerId: ids.loyalty[0] ?? ids.customer[0] ?? (ids.phone[0] && `phone:${ids.phone[0]}`) ?? (ids.cards[0] && `card:${ids.cards[0]}`) ?? `check:${visits[0].checkGuid}`,
    identityStrength: strength,
    name: mostCommon(visits.flatMap((v) => v.names)),
    ids,
    firstVisit: days[0],
    lastVisit: days.at(-1),
    visitDays: days.length,
    checks: visits.length,
    totalSpend: round(spend),
    avgCheck: round(spend / visits.length),
    loyaltyChecks: visits.filter((v) => v.loyaltyAccrued).length,
    loyaltyRedeemed: round(visits.flatMap((v) => v.loyaltyRedemptions).reduce((s, r) => s + (r.amount ?? 0), 0)),
    topItems: [...itemCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty })),
    journey: visits.map((v) => ({
      date: v.businessDate,
      opened: v.openedDate,
      checkGuid: v.checkGuid,
      orderGuid: v.orderGuid,
      source: v.source,
      revenueCenter: v.revenueCenter,
      total: v.total,
      tip: round(v.tip),
      paymentTypes: v.paymentTypes,
      loyaltyAccrued: v.loyaltyAccrued,
      loyaltyRedemptions: v.loyaltyRedemptions,
      identifiedBy: Object.entries(v.ids).filter(([, x]) => (Array.isArray(x) ? x.length : x)).map(([k]) => k),
      items: v.items.map((i) => i.name),
    })),
  };
}

const round = (n) => Math.round(n * 100) / 100;
