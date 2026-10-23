// Build customer profiles + journeys from the raw Toast export and report identifier coverage.
// Usage: node scripts/toast/journeys.js   (run toast:explore first)
// Writes data/toast/exports/{customers.json, customers.csv, journeys.jsonl, identity-report.json}

import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { extractChecks, resolveCustomers, buildProfile } from '../../src/toast/identity.js';

const raw = new URL('../../data/toast/raw/', import.meta.url);
const out = new URL('../../data/toast/exports/', import.meta.url);
await mkdir(out, { recursive: true });
const load = async (name, fallback) => JSON.parse(await readFile(new URL(name, raw), 'utf8').catch(() => fallback));

// Stream the order file: it is too large to read as one string, and we only keep the slim check rows.
const checks = [];
let orderCount = 0;
for await (const line of createInterface({ input: createReadStream(new URL('orders.jsonl', raw)) })) {
  if (!line) continue;
  checks.push(...extractChecks([JSON.parse(line)]));
  orderCount++;
}
const nameMap = (list) => new Map((list ?? []).map((x) => [x.guid, x.name]));
const revenueCenters = nameMap(await load('revenueCenters.json', '[]'));

const { clusters, sharedIdentifiers, vetoedCardLinks } = resolveCustomers(checks);
const profiles = clusters.map(buildProfile).sort((a, b) => b.totalSpend - a.totalSpend);
for (const p of profiles) for (const j of p.journey) j.revenueCenter = revenueCenters.get(j.revenueCenter) ?? j.revenueCenter;

// --- coverage report ---
const pct = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;
const has = (fn) => checks.filter(fn).length;
const coverage = {
  checks: checks.length,
  withLoyalty: has((c) => c.ids.loyalty),
  withCustomerGuid: has((c) => c.ids.customer),
  withPhone: has((c) => c.ids.phone),
  withEmail: has((c) => c.ids.email),
  withCard: has((c) => c.ids.cards.length),
  withAnyStrongId: has((c) => c.ids.loyalty || c.ids.customer || c.ids.phone || c.ids.email),
  withAnyId: has((c) => c.ids.loyalty || c.ids.customer || c.ids.phone || c.ids.email || c.ids.cards.length),
};
const strongCheckGuids = new Set(profiles.filter((p) => p.identityStrength === 'loyalty' || p.identityStrength === 'contact').flatMap((p) => p.journey.map((j) => j.checkGuid)));
const byStrength = Object.groupBy(profiles, (p) => p.identityStrength);
const repeat = profiles.filter((p) => p.identityStrength !== 'anonymous' && p.visitDays > 1);

const report = {
  dateRange: [checks.map((c) => c.businessDate).sort()[0], checks.map((c) => c.businessDate).sort().at(-1)],
  orders: orderCount,
  coverage,
  checksTiedToKnownGuestAfterCardLinking: strongCheckGuids.size,
  customers: Object.fromEntries(Object.entries(byStrength).map(([k, v]) => [k, v.length])),
  repeatCustomers: repeat.length,
  sharedIdentifiersIgnored: sharedIdentifiers,
  vetoedCardLinks: vetoedCardLinks.length,
};

console.log(`Toast identity report  ${report.dateRange.join(' -> ')}  (${orderCount} orders, ${checks.length} checks)\n`);
for (const [k, v] of Object.entries(coverage)) if (k !== 'checks') console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}  ${pct(v, checks.length)}`);
console.log(`\n  Checks tied to a loyalty/contact guest after card linking: ${strongCheckGuids.size} (${pct(strongCheckGuids.size, checks.length)})`
  + `  vs ${coverage.withAnyStrongId} from strong ids alone`);
console.log('\n  Customers by identity strength:', report.customers);
console.log(`  Repeat customers (2+ visit days): ${repeat.length}`);
console.log(`  Shared identifiers ignored: ${sharedIdentifiers.length}, card links vetoed: ${vetoedCardLinks.length}`);

// --- exports ---
const csvCell = (v) => { const s = Array.isArray(v) ? v.join('|') : String(v ?? ''); return /[",\n|]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const cols = ['customerId', 'identityStrength', 'name', 'phone', 'email', 'loyalty', 'cards', 'firstVisit', 'lastVisit', 'visitDays', 'checks', 'totalSpend', 'avgCheck', 'loyaltyChecks', 'loyaltyRedeemed', 'topItems'];
const csv = [cols.join(','), ...profiles.filter((p) => p.identityStrength !== 'anonymous').map((p) => cols.map((c) => csvCell(
  c === 'topItems' ? p.topItems.map((i) => `${i.name} x${i.qty}`) : p.ids[c] ?? p[c])).join(','))].join('\n');

await writeFile(new URL('customers.json', out), JSON.stringify(profiles.map(({ journey, ...p }) => p), null, 2));
await writeFile(new URL('customers.csv', out), csv);
await writeFile(new URL('journeys.jsonl', out), profiles.filter((p) => p.identityStrength !== 'anonymous').map((p) => JSON.stringify(p)).join('\n'));
await writeFile(new URL('identity-report.json', out), JSON.stringify(report, null, 2));
console.log(`\nWrote ${profiles.length} profiles to data/toast/exports/`);
