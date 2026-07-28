import { createClient } from '@supabase/supabase-js';

export const config = { maxDuration: 60 };

function decodeBody(payload) {
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

async function searchGmail(accessToken, query, maxResults = 10) {
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(maxResults, 20)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  if (!listRes.ok) return { error: listData.error?.message || 'search failed' };
  const ids = (listData.messages || []).map(m => m.id);
  if (!ids.length) return { count: 0, messages: [] };

  const results = await Promise.all(ids.map(async (id) => {
    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!mRes.ok) return null;
    const msg = await mRes.json();
    const headers = msg.payload?.headers || [];
    return {
      id,
      subject: headers.find(h => h.name === 'Subject')?.value || '',
      from: headers.find(h => h.name === 'From')?.value || '',
      date: headers.find(h => h.name === 'Date')?.value || '',
      snippet: msg.snippet || ''
    };
  }));
  return { count: results.filter(Boolean).length, messages: results.filter(Boolean) };
}

async function readEmail(accessToken, messageId) {
  const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!mRes.ok) return { error: 'failed to fetch message' };
  const msg = await mRes.json();
  const headers = msg.payload?.headers || [];
  const body = decodeBody(msg.payload).slice(0, 3000) || msg.snippet || '';
  return {
    subject: headers.find(h => h.name === 'Subject')?.value || '',
    from: headers.find(h => h.name === 'From')?.value || '',
    date: headers.find(h => h.name === 'Date')?.value || '',
    body
  };
}

const TOOLS = [
  {
    name: 'search_gmail',
    description: "Search the user's real Gmail inbox using Gmail's search syntax. Wrap OR groups in parentheses, e.g. '(receipt OR order OR return OR refund) newer_than:150d', or 'category:updates newer_than:150d', or 'from:aritzia.com'. Returns matching messages with id, subject, from, date, and a short snippet — not the full body.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A Gmail search query, using parentheses around any OR groups' },
        max_results: { type: 'integer', description: 'Max messages to return, default 10, max 20' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_email',
    description: 'Fetch the full body text of one specific email by its Gmail message id, once search_gmail has identified it as worth a closer look.',
    input_schema: {
      type: 'object',
      properties: { message_id: { type: 'string' } },
      required: ['message_id']
    }
  }
];

async function callClaude(messages, key, withTools) {
  const body = { model: 'claude-sonnet-4-6', max_tokens: 2000, messages };
  if (withTools) body.tools = TOOLS;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  return r.json();
}

function extractJsonArray(text) {
  const match = (text || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
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

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' });

  const today = new Date().toISOString().slice(0, 10);

  let messages = [{
    role: 'user',
    content: `You're an agent with real access to a Gmail inbox, via the search_gmail and read_email tools. Your job: find genuine order confirmations (implying a return window), return/refund-processed notices (store credit issued), gift card emails, order confirmations where the payment section shows a retailer-specific stored balance being spent, AND purchases that include an explicit extended warranty or protection plan.

That gift-card category is the subtle one — every retailer names their own version of it differently, so don't pattern-match on the literal words "gift card." The concept: any payment line that is a balance issued BY that specific retailer or platform, redeemable only there — as opposed to a normal bank card, PayPal, or Apple Pay. Examples of what this looks like on a real receipt, all the same underlying thing: "Gift Card: -$18.00", "Store Credit Applied", "Uber Cash" as the payment method, "Starbucks Card", "Amazon Gift Card Balance", a rewards/loyalty balance used as payment. Read the actual payment/checkout section of each candidate email and judge whether a balance like this was used — the label varies by company, the concept doesn't.

For warranties: only flag this when the email explicitly names a warranty, protection plan, or coverage term — "AppleCare", "SquareTrade", "Asurion", "2-Year Protection Plan", "Extended Warranty", etc. Don't infer a standard manufacturer warranty just because something is electronics — that's too unreliable from an email alone.

Today's date is ${today}.

Gmail search tips: wrap OR groups in parentheses, e.g. (receipt OR order OR "order confirmation" OR return OR refund OR warranty OR "protection plan") newer_than:150d. category:updates newer_than:150d is a good broad first pass since retail receipts usually land there. Try at least 2-3 different searches from different angles before concluding there's nothing — a single search missing results doesn't mean the inbox is empty. Use read_email on genuinely promising candidates (based on subject/snippet) to confirm details and extract accurate amounts/dates — this matters especially for spotting a gift-card-payment line, since that's usually buried in a totals/payment section, not the subject.

When you're confident you've covered the inbox well, respond with ONLY a JSON array (no markdown fences, no other text), even if empty:
[{"kind":"credit"|"gift"|"return"|"gift_redemption"|"warranty","store":"...","amount":0.00,"itemName":"(for kind return or warranty)","deadline":"YYYY-MM-DD (for kind return: the return deadline, estimate 30 days out if not stated; for kind warranty: purchase date plus the stated coverage length)","code":""}]
Use kind "gift_redemption" when a gift card was spent as payment on an order — amount is however much of the gift card was applied.`
  }];

  const MAX_TURNS = 10;
  const START = Date.now();
  const TIME_BUDGET_MS = 38000; // leave room for the forced final answer + response
  let items = [];

  try {
    let answered = false;
    for (let turn = 0; turn < MAX_TURNS && (Date.now() - START) < TIME_BUDGET_MS; turn++) {
      const data = await callClaude(messages, key, true);
      if (data.error) return res.status(500).json({ error: data.error });

      const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
      const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

      if (!toolUses.length) {
        items = extractJsonArray(textBlocks);
        answered = true;
        break;
      }

      messages.push({ role: 'assistant', content: data.content });
      const toolResults = await Promise.all(toolUses.map(async (tu) => {
        let result;
        try {
          if (tu.name === 'search_gmail') result = await searchGmail(accessToken, tu.input.query, tu.input.max_results);
          else if (tu.name === 'read_email') result = await readEmail(accessToken, tu.input.message_id);
          else result = { error: 'unknown tool' };
        } catch (e) {
          result = { error: String(e) };
        }
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
      }));
      messages.push({ role: 'user', content: toolResults });
    }

    // Out of time or turns while still investigating — force one final,
    // tool-free answer instead of silently returning nothing.
    if (!answered) {
      messages.push({
        role: 'user',
        content: "You're out of tool-call budget. Based on everything you've found so far, respond now with ONLY the JSON array — no more searching, no other text."
      });
      const data = await callClaude(messages, key, false);
      const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      items = extractJsonArray(textBlocks);
    }

    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
