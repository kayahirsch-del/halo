import { createClient } from '@supabase/supabase-js';
import { plaidFetch, RETURNABLE_CATEGORIES, returnWindowDays } from '../_lib/plaid.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const userJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!userJwt) return res.status(401).json({ error: 'Missing auth' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
  );
  const { data: { user }, error: userErr } = await supabase.auth.getUser(userJwt);
  if (userErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: item, error: itemErr } = await supabase
    .from('plaid_items').select('*').eq('user_id', user.id).single();
  if (itemErr || !item) return res.status(400).json({ error: 'not_connected' });

  try {
    // Plaid wants the `cursor` field left out entirely for the first sync —
    // sending it as null/empty string gets rejected with "cursor must be a
    // properly formatted string", so only include it when it's a real value.
    let cursor = item.cursor || undefined;
    let added = [];
    let hasMore = true;
    while (hasMore) {
      const body = { access_token: item.access_token };
      if (cursor) body.cursor = cursor;
      const page = await plaidFetch('/transactions/sync', body);
      added = added.concat(page.added || []);
      cursor = page.next_cursor || undefined;
      hasMore = page.has_more;
    }

    await supabase.from('plaid_items')
      .update({ cursor, updated_at: new Date().toISOString() })
      .eq('user_id', user.id);

    // Only posted, money-out transactions in a retail-ish category are
    // plausible "returnable purchases" — everything else (pending, refunds,
    // rent, transfers, dining, subscriptions) is skipped.
    const candidates = added
      .filter(tx => !tx.pending && tx.amount > 0)
      .filter(tx => RETURNABLE_CATEGORIES.has(tx.personal_finance_category?.primary))
      .map(tx => {
        const merchant = tx.merchant_name || tx.name || 'Store';
        return {
          plaid_transaction_id: tx.transaction_id,
          store: merchant,
          itemName: tx.name || 'Purchase',
          amount: tx.amount,
          deadline: new Date(new Date(tx.date).getTime() + returnWindowDays(merchant) * 86400000)
            .toISOString().slice(0, 10)
        };
      });

    return res.status(200).json({ items: candidates });
  } catch (e) {
    // Plaid hasn't finished its initial pull for this Item yet — happens for
    // a stretch (seconds to a few minutes, sometimes longer) right after
    // linking a new card. Not a real failure, just "ask again shortly."
    if (e.plaid?.error_code === 'PRODUCT_NOT_READY') {
      return res.status(400).json({ error: 'not_ready' });
    }
    return res.status(500).json({ error: e.message, detail: e.plaid });
  }
}
