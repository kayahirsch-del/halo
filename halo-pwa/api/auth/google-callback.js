// Handles the redirect back from Google after the user grants Gmail access.
// Exchanges the code for tokens (needs the client secret, so must run server-side),
// then stores the refresh token in Supabase, scoped to that user via RLS.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Google denied access: ${error}. <a href="/">Go back</a>`);
  if (!code || !state) return res.status(400).send('Missing code or state.');

  const userJwt = state; // the user's Supabase access token, passed through as `state`
  const redirectUri = `https://${req.headers.host}/api/auth/google-callback`;

  try {
    // Exchange the authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      // Google only sends a refresh_token on the FIRST consent. If she's reconnecting,
      // she may need to revoke access at myaccount.google.com/permissions first.
      return res.status(400).send(
        `Couldn't get a refresh token (${tokens.error || 'unknown error'}). ` +
        `If you've connected before, revoke Halo's access at ` +
        `<a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> and try again. ` +
        `<a href="/">Go back</a>`
      );
    }

    // Identify the user from their Supabase JWT, then write the token as that user (RLS-scoped)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
    );
    const { data: { user }, error: userErr } = await supabase.auth.getUser(userJwt);
    if (userErr || !user) return res.status(401).send('Could not verify your session. <a href="/">Go back and try again</a>');

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    const { error: upsertErr } = await supabase.from('google_tokens').upsert({
      user_id: user.id,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: expiresAt
    });
    if (upsertErr) return res.status(500).send(`Saved tokens but failed to store: ${upsertErr.message}`);

    res.writeHead(302, { Location: '/?gmail=connected' });
    res.end();
  } catch (e) {
    res.status(500).send(`Something went wrong: ${String(e)}. <a href="/">Go back</a>`);
  }
}
