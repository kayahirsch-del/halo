// Server-side proxy to Anthropic. Keeps ANTHROPIC_API_KEY off the client.
// modes: "email" (classify a pasted email), "photo" (gift card OCR),
//        "policy" (web-search-grounded return policy + card benefit lookup)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' });

  const { mode, text, image, mediaType, store } = req.body || {};
  const today = new Date().toISOString().slice(0, 10);

  let body;

  if (mode === 'email') {
    body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Classify this email as one of: store credit/refund issued ("credit"), gift card issued ("gift"), or a purchase/order confirmation implying a return window ("return"). Respond with ONLY valid JSON, no markdown:
{"found":true|false,"kind":"credit"|"gift"|"return","store":"...","amount":0.00,"itemName":"main item, only for kind return","deadline":"YYYY-MM-DD if stated, else empty string","code":"any code mentioned, else empty string"}
Today's date is ${today}. Email:
${(text || '').slice(0, 3000)}`
      }]
    };
  } else if (mode === 'photo') {
    body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: `Extract gift card details. Respond with ONLY valid JSON, no markdown:
{"store":"...","code":"card number exactly as shown","pin":"PIN if visible else empty string","amount":0.00 or null}` }
        ]
      }]
    };
  } else if (mode === 'policy') {
    body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Look up the current return policy for "${store}" and note any common credit card purchase-protection or extended-warranty benefits (e.g. Chase Sapphire Reserve, Amex Platinum) that typically apply to purchases there. Respond with your findings, then end with ONLY a JSON object on its own line, no markdown fences:
{"returnWindowDays": number, "policyNote": "one sentence, current as of your search", "cardBenefitNote": "one sentence on common card protections, or empty string"}`
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    };
  } else {
    return res.status(400).json({ error: 'unknown mode' });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });

    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return res.status(200).json({ raw: textBlocks });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
