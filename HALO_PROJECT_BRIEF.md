# Halo — Project Brief for Claude Code

## What this is
Halo is a store credit / gift card / return window / warranty tracker. Not a budgeting app —
it never shows total spend, never sets limits, never sends "you're approaching your budget"
style notifications. Positioning: "advocate, not scolder." Tagline direction: *"Spend the way
you want. Halo makes sure none of it goes to waste."*

Core loop: user adds purchases (via Gmail scan, pasting one email, or a gift card photo) →
Halo extracts store credit, gift cards, return windows, and warranties → surfaces what's
expiring soonest → user takes action (return it, redeem it, claim it) with one tap.

## Goal for this phase
Build a real iOS app in Expo/React Native that replicates the existing PWA, ships via
EAS Build → TestFlight, so it can be shared with friends via a TestFlight link — not just
"Add to Home Screen."

**Reuse the existing backend as-is. Only the frontend is being rebuilt.**

---

## Existing infrastructure (already live — do not recreate)

### Supabase
- Project: `halo`, ref `xquowncywffexwomifjc`, region us-east-1
- URL: `https://xquowncywffexwomifjc.supabase.co`
- Anon/publishable key (safe to embed client-side):
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxdW93bmN5d2ZmZXh3b21pZmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MzUxNTIsImV4cCI6MjEwMDQxMTE1Mn0.UtYcFdPDxLUAMywelFR5O4BExp9cIxuj3vHfDqPU99A`

### Schema (already applied via migration)
```sql
create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('credit','gift','return','warranty')),
  store text not null,
  item_name text,
  amount numeric(10,2),
  remaining numeric(10,2),
  code text,
  pin text,
  deadline date,
  status text not null default 'active' check (status in ('active','handled')),
  added_on date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.item_usage (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  used_on date not null default current_date,
  amount numeric(10,2) not null,
  created_at timestamptz not null default now()
);

create table public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  access_token text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.plaid_items (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,
  item_id text not null,
  cursor text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```
`items` also has a nullable `plaid_transaction_id text` column (unique where not null) so
purchases synced from Plaid aren't imported twice.

All tables have RLS enabled, scoped to `auth.uid() = user_id` (or via the parent
`items` row for `item_usage`). Auth is currently anonymous sign-in
(`supabase.auth.signInAnonymously()`) — every device gets its own persistent anonymous
user unless we add real login later. **Anonymous sign-ins must be enabled in the Supabase
dashboard under Authentication → Settings — check this is on.**

### Vercel backend (deployed, holds all secrets — keep using it, don't move secrets into the app)
Base URL: `https://halo-pwa-1.vercel.app` (or whatever custom domain it ends up on)

- **`POST /api/parse`** — body `{ mode, ... }`
  - `mode:"email"` — `{ text }` → classifies a pasted email as credit/gift/return, extracts fields
  - `mode:"photo"` — `{ image (base64), mediaType }` → OCRs a gift card photo (number/PIN/balance)
  - `mode:"policy"` — `{ store }` → web-search-grounded current return policy + common credit
    card purchase-protection/extended-warranty notes
  - Returns `{ raw: "<text response>" }` — caller parses JSON out of it (may have prose before/after)

- **`POST /api/gmail/scan`** — header `Authorization: Bearer <supabase access token>`.
  Refreshes the user's Google token, searches their real Gmail (last 60 days, receipts/
  returns/gift cards), sends matches to Claude for extraction. Returns `{ items: [...] }`
  or `{ error: "not_connected" }` if they haven't linked Gmail yet.

- **`GET /api/config`** — returns `{ googleClientId, redirectUri }` (non-secret, safe to fetch client-side)

- **`GET /api/auth/google-callback`** — OAuth callback. **This is web-redirect based and
  needs adapting for native** — see "Known gap" below.

- **`POST /api/plaid/create_link_token`** — header `Authorization: Bearer <supabase access token>`.
  Creates a Plaid Link token scoped to that user (`client_user_id`). Returns `{ link_token }`.

- **`POST /api/plaid/exchange_token`** — header `Authorization: Bearer <supabase access token>`,
  body `{ public_token }` from a completed Plaid Link flow. Exchanges it for an access token
  and stores it in `public.plaid_items`, scoped to that user via RLS.

- **`POST /api/plaid/sync`** — header `Authorization: Bearer <supabase access token>`. Calls
  Plaid's `/transactions/sync` with the user's stored cursor, advances and persists that
  cursor, then filters newly-added transactions down to retail-ish purchases
  (`personal_finance_category.primary` in `GENERAL_MERCHANDISE` / `HOME_IMPROVEMENT` /
  `PERSONAL_CARE`, posted, money-out only) and returns them as candidate return-window items
  (`{ items: [{ plaid_transaction_id, store, itemName, amount, deadline }] }`) for the client
  to review and import via the existing scan-review UI.

Server-side env vars already required on Vercel (already set or in progress):
`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` (`sandbox` / `development` / `production`,
defaults to `sandbox` if unset).

---

## Known gap: mobile OAuth
The current Google OAuth flow redirects to a web page (`/?gmail=connected`). For a native
app, use `expo-auth-session` (`WebBrowser.openAuthSessionAsync`) with a custom redirect —
either Expo's auth proxy during development or a custom URL scheme (`halo://`) for the
built app. This requires **adding a new Authorized redirect URI in the same Google Cloud
OAuth Client** (Google Cloud Console → Credentials → the existing Halo Web client) —
that's a five-minute console step, not new backend code. The rest of the flow (token
exchange, refresh, storage in `google_tokens`) stays exactly as-is in `/api/auth/google-callback.js`.

---

## Design language
- Colors: gold `#E9B94D`, peach `#F2997F`, lilac `#B7A6E9` (gradient used for the brand
  mark/hero), ink `#1B1B20` (text), muted `#8B8A94`, sage `#37714F`/`#E7F1E8` (success/money),
  amber `#94660F`/`#FBEFD7` (attention/soon), red `#B4453A`/`#FBE3DC` (urgent)
- Font: system default (SF Pro on iOS)
- Tone: celebratory, never a scold. Never show a "total spent" number anywhere.

## Screens to build
1. **Log (home)** — tally card (total available = store credit + gift cards, split shown),
   a "soonest deadline" banner, then two sections: **On the clock** (return windows +
   warranties, sorted soonest-first, color-coded countdown badges) and **Money available**
   (store credit + gift cards), plus a collapsed **Handled** section.
2. **Add** — four entry points: Scan my inbox (Gmail), Paste one email, Add a gift card
   photo, Log a warranty (manual form: item, store, purchase date, coverage length dropdown
   → auto-computes deadline).
3. **Detail sheet** (modal/bottom sheet) — for money items: card number + PIN with
   copy-to-clipboard, remaining balance, a "log partial usage" input, usage history. For
   clock items: big countdown, a "Check current policy & card benefits" button (calls
   `/api/parse` mode `policy`), a "mark as returned/claimed" action.

## Data mapping notes
- `remaining` only applies to kind `credit`/`gift` (gift cards get spent partially — track
  via `item_usage` rows, don't just decrement in place, keep the log)
- `deadline` only applies to kind `return`/`warranty`
- An item is "done" when: money items have `remaining <= 0`, or clock items have
  `status = 'handled'` or `deadline` has passed

---

## Distribution (needs the user's own accounts — can't be done by Claude Code alone)
- **Apple Developer Program** — $99/year, developer.apple.com. Required for TestFlight.
- **Expo account** — free, expo.dev. Required for EAS Build.
- Path: `npx create-expo-app halo-ios`, build the screens, `eas build --platform ios`,
  `eas submit -p ios`, then generate a public TestFlight link from App Store Connect to
  share with friends (supports up to 10,000 external testers, no full App Store review
  required for TestFlight distribution).

## What NOT to do
- Don't create a new Supabase project or new tables — reuse `halo` as documented above.
- Don't put `ANTHROPIC_API_KEY` or `GOOGLE_CLIENT_SECRET` in the mobile app's code or
  bundle — those stay server-side in Vercel only. The app calls the Vercel API routes
  instead of calling Anthropic or Google directly.
