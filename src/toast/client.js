// Minimal Toast API client: machine-client auth, retries on 429/5xx, and pagination helpers.

const DEFAULT_HOST = 'https://ws-api.toasttab.com';

export class ToastClient {
  constructor({
    host = process.env.TOAST_API_HOST ?? DEFAULT_HOST,
    clientId = process.env.TOAST_CLIENT_ID,
    clientSecret = process.env.TOAST_CLIENT_SECRET,
    userAccessType = process.env.TOAST_USER_ACCESS_TYPE ?? 'TOAST_MACHINE_CLIENT',
  } = {}) {
    if (!clientId || !clientSecret) throw new Error('TOAST_CLIENT_ID and TOAST_CLIENT_SECRET are required');
    this.host = host.replace(/\/$/, '');
    this.creds = { clientId, clientSecret, userAccessType };
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async authenticate() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await fetch(`${this.host}/authentication/v1/authentication/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.creds),
    });
    if (!res.ok) throw new Error(`Toast auth failed: ${res.status} ${await res.text()}`);
    const { token } = await res.json();
    this.token = token.accessToken;
    this.tokenExpiresAt = Date.now() + token.expiresIn * 1000;
    // token.scope is sometimes null in the login response; the JWT always carries it.
    const claims = JSON.parse(Buffer.from(this.token.split('.')[1], 'base64url').toString());
    this.scopes = (token.scope ?? claims.scope ?? '').split(' ').filter(Boolean);
    return this.token;
  }

  /** GET a path. Returns { status, headers, body } so callers can probe endpoints without throwing. */
  async raw(path, { restaurantGuid, query, attempt = 0 } = {}) {
    const token = await this.authenticate();
    const url = new URL(this.host + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers = { Authorization: `Bearer ${token}` };
    if (restaurantGuid) headers['Toast-Restaurant-External-ID'] = restaurantGuid;

    const res = await fetch(url, { headers });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.raw(path, { restaurantGuid, query, attempt: attempt + 1 });
    }
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, headers: res.headers, body };
  }

  async get(path, opts) {
    const { status, body } = await this.raw(path, opts);
    if (status >= 400) throw new Error(`GET ${path} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    return body;
  }

  /** Page-number pagination (orders/ordersBulk and similar): keeps going until a short page. */
  async *paginate(path, { restaurantGuid, query = {}, pageSize = 100 } = {}) {
    for (let page = 1; ; page++) {
      const items = await this.get(path, { restaurantGuid, query: { ...query, page, pageSize } });
      if (!Array.isArray(items) || items.length === 0) return;
      yield* items;
      if (items.length < pageSize) return;
    }
  }

  /** Connected restaurants for this machine client. */
  listRestaurants() {
    return this.get('/partners/v1/restaurants');
  }

  /**
   * Orders with full detail (checks, payments, customer, loyalty) between two dates.
   * Toast limits each ordersBulk window to 1 month, so we walk day by day.
   */
  async *orders(restaurantGuid, start, end) {
    for (let d = new Date(start); d < end; d = new Date(d.getTime() + 86_400_000)) {
      const next = new Date(Math.min(d.getTime() + 86_400_000, end.getTime()));
      yield* this.paginate('/orders/v2/ordersBulk', {
        restaurantGuid,
        query: { startDate: toToastDate(d), endDate: toToastDate(next) },
      });
    }
  }
}

/** Toast wants ISO-8601 with millis and a numeric offset, e.g. 2026-10-01T00:00:00.000+0000 */
export function toToastDate(date) {
  return date.toISOString().replace('Z', '+0000');
}
