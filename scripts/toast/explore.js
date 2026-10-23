// Probe which Toast endpoints this client can reach and dump raw samples to data/toast/raw.
// Usage: node --env-file=.env scripts/toast/explore.js [days=30]

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { ToastClient, toToastDate } from '../../src/toast/client.js';

const days = Number(process.argv[2] ?? 30);
const outDir = new URL('../../data/toast/raw/', import.meta.url);
await mkdir(outDir, { recursive: true });
const save = (name, data) => writeFile(new URL(name, outDir), JSON.stringify(data, null, 2));

const toast = new ToastClient();
await toast.authenticate();
console.log('Scopes:', toast.scopes.join(', '));

const restaurants = await toast.listRestaurants();
await save('restaurants.json', restaurants);
const guid = process.env.TOAST_RESTAURANT_GUID ?? restaurants[0].restaurantGuid;
console.log(`Restaurant: ${restaurants.find((r) => r.restaurantGuid === guid)?.restaurantName} (${guid})`);

const end = new Date();
const start = new Date(end.getTime() - days * 86_400_000);

// Endpoints worth knowing about for identity / journey work. Status tells us what's reachable.
const probes = {
  restaurant: `/restaurants/v1/restaurants/${guid}`,
  diningOptions: '/config/v2/diningOptions',
  revenueCenters: '/config/v2/revenueCenters',
  serviceAreas: '/config/v2/serviceAreas',
  tables: '/config/v2/tables',
  discounts: '/config/v2/discounts',
  tenders: '/config/v2/alternatePaymentTypes',
  employees: '/labor/v1/employees',
  menus: '/menus/v2/menus',
  cashEntries: '/cashmgmt/v1/entries',
  // Guest / loyalty specific endpoints (likely need extra scopes or partner programs)
  crmCustomers: '/crm/v1/customers',
  guestProfiles: '/guest/v1/guests',
  loyalty: '/loyalty/v1/accounts',
  giftCards: '/giftcards/v1/cards',
};

const summary = {};
for (const [name, path] of Object.entries(probes)) {
  const query = name === 'cashEntries' ? { businessDate: toToastDate(end).slice(0, 10).replaceAll('-', '') } : undefined;
  const { status, body } = await toast.raw(path, { restaurantGuid: guid, query });
  summary[name] = { path, status, count: Array.isArray(body) ? body.length : undefined };
  if (status < 400) await save(`${name}.json`, body);
  console.log(`${String(status).padEnd(4)} ${name.padEnd(15)} ${path}`);
}

console.log(`\nPulling orders for the last ${days} days...`);
// Streamed as JSONL: months of full order detail blow past V8's max string length as one JSON doc.
const file = createWriteStream(new URL('orders.jsonl', outDir));
let count = 0;
for await (const order of toast.orders(guid, start, end)) {
  if (!file.write(JSON.stringify(order) + '\n')) await new Promise((r) => file.once('drain', r));
  if (++count % 1000 === 0) console.log(`  ${count} orders (through ${order.businessDate})`);
}
await new Promise((r) => file.end(r));
summary.orders = { count, start: start.toISOString(), end: end.toISOString() };
console.log(`Orders: ${count}`);

await save('_summary.json', summary);
