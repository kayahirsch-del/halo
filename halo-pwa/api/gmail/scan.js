import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

function decodeBody(payload) {
  // Walk a Gmail message payload for the best text part available.
  if (!payload) return '';
  const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64urlDecode(payload.body.data);
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) return b64urlDecode(plain.body.data);
    const html = payload.parts.find(p => p.mimeType === 'text/html');
    if (html?.body?.data) return b64urlDecode(html.body.data).replace(/<[^>]+>/g, ' ');
    for (const p of payload.parts) {
      const nested = decodeBody(p);
      if (nested) return nested;
    }
  }
  if (payload.body?.data) return b64urlDecode(payload.body.data);
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const authHeader = req.headers.authorization || '';
  const userJwt = authHeader.replace('Bearer ', '');
  if (!userJwt) return res.status(401).json({ error: 'Missing auth' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
  );

  const { data: { user }, error: userErr } = await supabase.auth.getUser(userJwt);
  if (userErr || !user) return res.status(401).json({ error: 'Invalid session' });

  const { data: tokenRow, error: tokErr } = await supabase
    .from('google_tokens').select('*').eq('user_id', user.id).single();
  if (tokErr || !tokenRow) return res.status(400).json({ error: 'not_connected' });

  // Refresh the access token
  let accessToken;
  try {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: tokenRow.refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const refreshed = await refreshRes.json();
    if (!refreshRes.ok) return res.status(400).json({ error: 'token_refresh_failed', detail: refreshed });
    accessToken = refreshed.access_token;
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }

  // Search Gmail
  const query = encodeURIComponent('(receipt OR order OR "return" OR "refund" OR "store credit" OR "gift card") newer_than:60d');
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=25`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const listData = await listRes.json();
  if (!listRes.ok) return res.status(400).json({ error: 'gmail_search_failed', detail: listData });
  const ids = (listData.messages || []).map(m => m.id);
  if (!ids.length) return res.status(200).json({ items: [] });

  // Fetch each message and pull subject + body text
  const emails = [];
  for (const id of ids) {
    const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!mRes.ok) continue;
    const msg = await mRes.json();
    const headers = msg.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    const body = decodeBody(msg.payload).slice(0, 1200);
    emails.push({ id, subject, from, date, body });
  }

  // Send the batch to Claude for classification/extraction
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' });

  const today = new Date().toISOString().slice(0, 10);
  const batchText = emails.map((e, i) =>
    `--- Email ${i + 1} ---\nFrom: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nBody: ${e.body}`
  ).join('\n\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `Below are emails from a real inbox. For each one that is an order confirmation (implying a return window), a return/refund-processed notice (store credit issued), or a gift card email, extract a record. Ignore anything irrelevant (newsletters, unrelated receipts like transit/subscriptions, etc). Today's date is ${today}.

Respond with ONLY a JSON array, no markdown fences, no other text, even if empty:
[{"kind":"credit"|"gift"|"return","store":"...","amount":0.00,"itemName":"(only for kind return)","deadline":"YYYY-MM-DD (only for kind return; estimate 30 days from the email date if the store's policy isn't stated)","code":""}]

${batchText}`
        }]
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data });
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const match = textBlocks.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
