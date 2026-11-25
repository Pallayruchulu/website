# Pallay Ruchulu — Online Store, Owner Dashboard & Staff Tracking

A customer website for ordering fresh batters, chapati and poori; a private owner dashboard; and private phone pages for stall staff.
It is hosted on **Vercel**, with data in **Supabase** (Postgres database plus a private photo store).

```
public/            web pages (store, /admin dashboard, /staff/<link> staff page)
api/index.js       Vercel serverless entry → lib/handler.js
lib/               API: store, orders, stock, staff, salary & expenses
supabase/schema.sql  database tables, stock-safe functions, security, starting products
server.js          local test server (same API)
```

## One-time setup

### 1. Supabase (database)
1. Open your project → **SQL Editor** → **New query**.
2. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. It creates the tables, the five products, a private `selfies` photo bucket, and locks every table so only the server can access it.
3. Go to **Project Settings → API Keys** and copy the **service_role** (secret) key. Keep it private: never put it in the website code, GitHub or chat.

### 2. Vercel (website hosting)
1. https://vercel.com/new → **Import** the GitHub repo `Pallayruchulu/website`.
2. Framework preset: **Other**. No build command needed.
3. **Environment Variables** — add:
   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | `https://zmztnugzactvhydlnxfe.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key from step 1.3 |
   | `ADMIN_PASSWORD` | a strong owner password |
4. **Deploy**. Every later `git push` to `main` redeploys automatically.

The site is served over HTTPS, which phones require for staff GPS check-in.

## Run locally (optional)
```bash
npm install
cp .env.example .env     # fill in the 3 values (this file is git-ignored)
npm start                # http://localhost:3000  and  /admin
```
Local runs use the **same Supabase database** as the live site.

## Features

**Customer website**: opening animation, product menu with stock badges, basket → checkout (delivery or pickup, cash or UPI), order ID + UPI pay + WhatsApp share, order tracking, Google Maps, WhatsApp button.

**Owner dashboard** (`/admin`)
- **Overview**: packets sold today/this month, sales ₹, stock in hand, orders to deliver, 14-day chart, per-product table, low-stock alerts
- **Orders**: status flow New → Packing → Out for delivery → Delivered; cancelling returns stock; call/WhatsApp customer; new-order sound
- **Stock**: daily production, waste/expired, corrections, full history
- **Shop sale**: tap-to-bill counter for walk-in customers
- **Staff & stalls**: see below
- **Salary & expenses**: salary/advance/bonus, rent, raw material, packaging etc., monthly profit estimate
- **Products / Settings / Export to Excel (CSV)**

**Staff at stalls**
1. Dashboard → Staff & stalls → add person → **Send on WhatsApp** (private link; **New link** cancels the old one).
2. Set the stall location once ("Use my current location" while standing at the stall).
3. Staff: **Check in** = selfie + GPS, **Check out** = GPS. Location is taken **only** at these two moments, never in between.
4. You: live status (at stall / away X km / not in / checked out), latest selfie, **🔔 Ask for a selfie now** (selfie only, no GPS), messages, tasks with done/pending, attendance and hours, and stall sales.

Tell your staff that a selfie and location are recorded at check-in/check-out.

## Security notes
- Customers' browsers never talk to Supabase directly. All data goes through the server using the service_role key, and every table has Row Level Security on with no public access.
- Owner login uses a signed, HttpOnly cookie. Changing `ADMIN_PASSWORD` in Vercel logs everyone out.
- Selfies are in a private bucket and are shown to the owner only through links that expire after 10 minutes.
