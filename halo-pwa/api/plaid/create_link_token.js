import { createClient } from '@supabase/supabase-js';
import { plaidFetch } from '../_lib/plaid.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return res.status(500).json({ error: 'Plaid is not configured on this deployment yet' });
  }

  const userJwt = (req.headers.authorization || '').replace('Bearer ', '');
  if (!userJwt) return res.status(401).json({ error: 'Missing auth' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
  );
  const { data: { user }, error: userErr } = await supabase.auth.getUser(userJwt);
  if (userErr || !user) return res.status(401).json({ error: 'Invalid session' });

  try {
    const data = await plaidFetch('/link/token/create', {
      user: { client_user_id: user.id },
      client_name: 'Halo',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en'
    });
    return res.status(200).json({ link_token: data.link_token });
  } catch (e) {
    return res.status(500).json({ error: e.message, detail: e.plaid });
  }
}
