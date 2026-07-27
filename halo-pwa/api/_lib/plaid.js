// Shared helpers for the Plaid API routes. Underscore-prefixed folder so
// Vercel doesn't treat this as a route of its own.

const PLAID_BASE = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com'
};

export function plaidBaseUrl() {
  return PLAID_BASE[process.env.PLAID_ENV || 'sandbox'];
}

export async function plaidFetch(path, body) {
  const res = await fetch(plaidBaseUrl() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      ...body
    })
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error_message || 'Plaid request failed'), { plaid: data });
  return data;
}

// Only these Plaid personal-finance-category "primary" values look like
// retail purchases with a plausible return window — everything else (rent,
// transfers, dining, subscriptions, bills, etc.) is skipped.
export const RETURNABLE_CATEGORIES = new Set([
  'GENERAL_MERCHANDISE',
  'HOME_IMPROVEMENT',
  'PERSONAL_CARE'
]);

// Mirrors RETURN_WINDOWS in index.html — kept as a separate copy since this
// runs server-side for card purchases instead of client-side email parsing.
const RETURN_WINDOWS = {
  aritzia: 30, zara: 30, target: 90, amazon: 30, sephora: 30, nordstrom: 365, uniqlo: 30,
  nike: 60, lululemon: 30, 'best buy': 15, apple: 14, everlane: 30, madewell: 30, ssense: 14, revolve: 30
};

export function returnWindowDays(merchantName) {
  const name = (merchantName || '').toLowerCase();
  for (const store of Object.keys(RETURN_WINDOWS)) {
    if (name.includes(store)) return RETURN_WINDOWS[store];
  }
  return 30;
}
