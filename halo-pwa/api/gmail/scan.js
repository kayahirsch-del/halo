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

// ---- Real Gmail tool implementations, called by Claude mid-conversation ----

async function searchGmail(accessToken, query, maxResults = 10) {
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(maxResults, 20)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  if (!listRes.ok) return { error: listData.error?.message || 'search failed' };
  const ids = (listData.messages || []).map(m => m.id);
  if (!ids.length) return { count: 0, messages: [] };

  // metadata-only fetch (fast, no body decode) so Claude can triage before reading in full
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
    description: "Search the user's real Gmail inbox using Gmail's search syntax (e.g. 'category:updates newer_than:150d', 'from:aritzia.com', '\"gift card\"'). Returns matching messages with id, subject, from, date, and a short snippet — not the full body.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A Gmail search query' },
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

async function callClaude(messages, key) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, tools: TOOLS, messages })
  });
  return r.json();
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
    content: `You're an agent with real access to a Gmail inbox, via the search_gmail and read_email tools. Your job: find genuine order confirmations (implying a return window), return/refund-processed notices (store credit issued), and gift card emails from roughly the last 5 months. Today's date is ${today}.

Don't rely on one search. Try a few different angles — e.g. category:updates newer_than:150d for a broad first pass, then targeted terms like receipt, "order confirmation", "your order", "return", "refund", "store credit", "gift card" if the first pass looks thin. Use read_email on genuinely promising candidates to confirm details and extract accurate amounts/dates — don't read everything, use the subject/snippet from search results to triage first. You have a limited number of tool calls, so be efficient: a few well-chosen searches plus reading the real candidates beats exhaustively reading everything.

When you're confident you've covered the inbox well, respond with ONLY a JSON array (no markdown fences, no other text), even if empty:
[{"kind":"credit"|"gift"|"return","store":"...","amount":0.00,"itemName":"(only for kind return)","deadline":"YYYY-MM-DD (only for kind return; estimate 30 days out if the policy isn't stated)","code":""}]`
  }];

  let finalText = '';
  const MAX_TURNS = 6;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const data = await callClaude(messages, key);
      if (data.error) return res.status(500).json({ error: data.error });

      const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
      const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (textBlocks) finalText = textBlocks;

      if (!toolUses.length) break;

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

    const match = finalText.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
