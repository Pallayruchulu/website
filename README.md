# Pallay Ruchulu — Online Store + Owner Dashboard

Customer website for ordering fresh batters, chapati and poori, plus a private owner dashboard for sales, stock and orders. It needs only Node.js 18 or newer and has no packages to install.

## Run it

```bash
npm start
```

- Store: http://localhost:3000
- Owner dashboard: http://localhost:3000/admin (default password `pallay@123`)

**Before going live, set your own password:**

```powershell
$env:ADMIN_PASSWORD = "your-strong-password"; npm start
```

## See it with sample data

```bash
npm run demo -- --force   # WIPES data/db.json and loads 30 days of fake orders
```

To start fresh for real business, delete `data/db.json` and restart. Products are recreated with default prices.

## What's inside

**Customer website**
- Opening animation: batter is poured and spread into a dosa on a tawa, then the logo appears (once per visit, skippable)
- Product menu with filters, "Only N left!" badges and sold-out handling
- Basket → checkout (home delivery or shop pickup, cash or UPI), free-delivery progress
- After ordering: order ID, UPI pay button, "send order on WhatsApp", celebration animation
- Order tracking by order ID + phone
- Floating WhatsApp button, Google Maps, open/closed indicator, batter tips

**Owner dashboard** (`/admin`)
- **Overview** — packets sold today/this month, sales ₹, packets in stock, orders to deliver, 14-day chart, per-product sold and stock table, low-stock alerts
- **Orders** — new orders (with sound alert), update status (New → Packing → Out for delivery → Delivered), cancel (stock is returned), call/WhatsApp the customer
- **Stock** — add each morning's production, record waste/expired packets, correct counts, full history
- **Shop sale** — tap-to-bill counter for walk-in customers (counted in sales and stock)
- **Products** — change prices, pack size, low-stock level, hide/show items, add new products
- **Settings** — phone, WhatsApp, UPI ID, address, hours, delivery charge
- **Export** — all orders as a CSV that opens in Excel
- **Staff & stalls** — see below
- **Salary & expenses** — pay salary/advance/bonus, record rent, raw material, packaging, gas etc., and see the monthly profit estimate (sales − expenses − staff paid)

## Staff at stalls (no calling needed)

1. Dashboard → **Staff & stalls** → add the person (name, phone, stall name, monthly salary or daily wage).
2. Open their card → **Send on WhatsApp** to share their private link (e.g. `https://yoursite/staff/abc123…`). There is no password, so keep the link private. **New link** cancels the old one.
3. Set the **stall location** once: stand at the stall and tap "Use my current location", or tap "Use their last check-in location".

What the staff member does on their phone (the link opens their own page):
- **Check in** = selfie + GPS. **Check out** = GPS. Location is taken **only** at these two moments and is never tracked in between or after check-out.
- Read your messages, mark tasks **Done**, and reply.
- Record stall sales. These are deducted from stock and appear in your dashboard as "Stall · name".

What you see:
- Live status card per person: ✅ checked in at stall / ⚠️ checked in X km away / 🕘 not checked in / 🏁 checked out, with their latest selfie.
- **🔔 Ask for a selfie now**: they get a request on their page and reply with a selfie (no GPS), so you can see they're at the stall.
- Quick follow-ups ("How many packets left?", "Send today's cash total"), tasks with done/pending, unread-message badge and sound.
- Attendance calendar (in/out times, hours). For daily-wage staff, salary = days present × wage.

> ⚠️ Phones only allow GPS on **https://** sites. Once hosted, the site must use HTTPS or check-in won't work. (`localhost` is fine for testing.)
> Tell your staff that a selfie and location are taken at check-in/check-out.

## Things to update first (Dashboard → Settings / Products)
- Real **phone number**, **WhatsApp number** and **UPI ID** (placeholders now)
- Real **prices** (₹80 / ₹80 / ₹110 / ₹60 / ₹60 are placeholders)

## Hosting
Any host that runs Node works: a small VPS, Render, Railway and similar. Keep the `data/` folder on persistent disk, because that is where orders and stock live, and back it up regularly. Put the site behind HTTPS.
