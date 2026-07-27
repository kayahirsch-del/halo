import { createClient } from '@supabase/supabase-js';
import { plaidFetch } from '../_lib/plaid.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const userJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!userJwt) return res.status(401).json({ error: 'Missing auth' });

  const { public_token } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'Missing public_token' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
  );
  const { data: { user }, error: userErr } = await supabase.auth.getUser(userJwt);
  if (userErr || !user) return res.status(401).json({ error: 'Invalid session' });

  try {
    const exch = await plaidFetch('/item/public_token/exchange', { public_token });
    const { error: upsertErr } = await supabase.from('plaid_items').upsert({
      user_id: user.id,
      access_token: exch.access_token,
      item_id: exch.item_id,
      cursor: null, // new Item (e.g. switching from Sandbox to Production) — old cursor is invalid for it
      updated_at: new Date().toISOString()
    });
    if (upsertErr) return res.status(500).json({ error: upsertErr.message });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message, detail: e.plaid });
  }
}
