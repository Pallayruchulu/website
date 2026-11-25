-- =====================================================================
-- Pallay Ruchulu — Supabase schema
-- Run this whole file once in Supabase → SQL Editor → New query → Run.
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
-- Only the server (service_role key) can read/write. The public anon key has NO access.
-- =====================================================================

create sequence if not exists order_no start 1001;

create table if not exists products (
  id            text primary key,
  name          text not null,
  telugu        text not null default '',
  description   text not null default '',
  unit          text not null default '1 pack',
  price         integer not null default 0 check (price >= 0),
  stock         integer not null default 0 check (stock >= 0),
  low_stock_at  integer not null default 10 check (low_stock_at >= 0),
  active        boolean not null default true,
  emoji         text not null default '🍽️',
  tag           text not null default '',
  image         text,
  sort          integer not null default 100,
  created_at    timestamptz not null default now()
);

create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null default '',
  role        text not null default 'Stall staff',
  stall_name  text not null default '',
  stall_lat   double precision,
  stall_lng   double precision,
  radius_m    integer not null default 150,
  pay_type    text not null default 'monthly' check (pay_type in ('monthly','daily')),
  salary      integer not null default 0,
  token       text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists orders (
  id          text primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  channel     text not null check (channel in ('online','shop','stall')),
  status      text not null check (status in ('new','preparing','out','delivered','cancelled')),
  customer    jsonb not null default '{}'::jsonb,
  mode        text not null default 'pickup',
  payment     text not null default 'cash',
  note        text not null default '',
  items       jsonb not null default '[]'::jsonb,
  subtotal    integer not null default 0,
  delivery    integer not null default 0,
  total       integer not null default 0,
  packets     integer not null default 0,
  staff_id    uuid references staff(id) on delete set null
);
create index if not exists orders_created_idx on orders (created_at desc);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_staff_idx on orders (staff_id, created_at);

create table if not exists movements (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  product_id  text not null references products(id) on delete cascade,
  type        text not null,            -- production | waste | adjust | sale | return
  qty         integer not null,
  note        text not null default '',
  ref         text
);
create index if not exists movements_at_idx on movements (at desc);

create table if not exists settings (
  id    integer primary key default 1 check (id = 1),
  data  jsonb not null default '{}'::jsonb
);

create table if not exists checkins (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references staff(id) on delete cascade,
  at           timestamptz not null default now(),
  type         text not null check (type in ('in','out','ping')),
  lat          double precision,
  lng          double precision,
  accuracy     integer,
  distance_m   integer,
  at_stall     boolean,
  photo        text
);
create index if not exists checkins_staff_idx on checkins (staff_id, at desc);
create index if not exists checkins_at_idx on checkins (at desc);

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  at          timestamptz not null default now(),
  from_role   text not null check (from_role in ('owner','staff')),
  kind        text not null default 'msg' check (kind in ('msg','task','checkin-request')),
  text        text not null,
  done        boolean not null default false,
  done_at     timestamptz,
  seen        boolean not null default false,
  checkin_id  uuid
);
create index if not exists messages_staff_idx on messages (staff_id, at desc);

create table if not exists payments (
  id        uuid primary key default gen_random_uuid(),
  staff_id  uuid not null references staff(id) on delete cascade,
  at        timestamptz not null default now(),
  month     text not null,                 -- 'YYYY-MM'
  amount    integer not null check (amount > 0),
  kind      text not null default 'salary' check (kind in ('salary','advance','bonus')),
  mode      text not null default 'cash',
  note      text not null default ''
);
create index if not exists payments_month_idx on payments (month);

create table if not exists expenses (
  id        uuid primary key default gen_random_uuid(),
  at        timestamptz not null default now(),
  date      date not null,
  category  text not null,
  amount    integer not null check (amount > 0),
  note      text not null default ''
);
create index if not exists expenses_date_idx on expenses (date desc);

-- All-time totals (security_invoker so RLS applies: anon sees nothing)
create or replace view order_stats with (security_invoker = true) as
  select coalesce(sum(packets),0)::bigint as packets, coalesce(sum(total),0)::bigint as revenue
  from orders where status <> 'cancelled';

-- ---------------------------------------------------------------------
-- Atomic operations (one transaction each, so stock can never go wrong)
-- ---------------------------------------------------------------------

-- Creates an order of any channel, checking and deducting stock.
create or replace function create_order(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_sub integer := 0; v_pk integer := 0; v_delivery integer := 0;
  v_id text; r record; v_prod products%rowtype; v_order orders%rowtype;
begin
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Cart is empty';
  end if;
  v_id := 'PR' || nextval('order_no');
  for r in
    select e->>'id' as pid, sum((e->>'qty')::integer) as qty
    from jsonb_array_elements(p->'items') e group by 1 order by 1
  loop
    if r.qty is null or r.qty <= 0 or r.qty > 100 then raise exception 'Invalid quantity'; end if;
    select * into v_prod from products where id = r.pid for update;
    if not found or not v_prod.active then raise exception 'Product not available'; end if;
    if v_prod.stock < r.qty then raise exception 'Only % pack(s) of % left', v_prod.stock, v_prod.name; end if;
    update products set stock = stock - r.qty where id = r.pid;
    insert into movements (product_id, type, qty, ref) values (r.pid, 'sale', -r.qty, v_id);
    v_items := v_items || jsonb_build_object('productId', r.pid, 'name', v_prod.name, 'qty', r.qty, 'price', v_prod.price);
    v_sub := v_sub + r.qty * v_prod.price;
    v_pk := v_pk + r.qty;
  end loop;
  if p->>'mode' = 'delivery' and v_sub < coalesce((p->>'free_above')::integer, 0) then
    v_delivery := coalesce((p->>'delivery_charge')::integer, 0);
  end if;
  insert into orders (id, channel, status, customer, mode, payment, note, items, subtotal, delivery, total, packets, staff_id)
  values (v_id, p->>'channel', p->>'status', coalesce(p->'customer','{}'::jsonb), coalesce(p->>'mode','pickup'),
          coalesce(p->>'payment','cash'), coalesce(p->>'note',''), v_items, v_sub, v_delivery, v_sub + v_delivery, v_pk,
          nullif(p->>'staff_id','')::uuid)
  returning * into v_order;
  return to_jsonb(v_order);
end $$;

-- Cancels an order and puts its packets back into stock.
create or replace function cancel_order(p_id text) returns jsonb
language plpgsql as $$
declare v orders%rowtype; it jsonb;
begin
  select * into v from orders where id = p_id for update;
  if not found then raise exception 'Order not found'; end if;
  if v.status = 'cancelled' then raise exception 'Cancelled orders cannot be changed'; end if;
  for it in select * from jsonb_array_elements(v.items) loop
    update products set stock = stock + (it->>'qty')::integer where id = it->>'productId';
    insert into movements (product_id, type, qty, note, ref) values (it->>'productId', 'return', (it->>'qty')::integer, 'Order cancelled', v.id);
  end loop;
  update orders set status = 'cancelled', updated_at = now() where id = p_id returning * into v;
  return to_jsonb(v);
end $$;

-- Production / waste / count correction.
create or replace function adjust_stock(p_product text, p_delta integer, p_type text, p_note text) returns jsonb
language plpgsql as $$
declare v products%rowtype;
begin
  select * into v from products where id = p_product for update;
  if not found then raise exception 'Product not found'; end if;
  if v.stock + p_delta < 0 then raise exception 'Only % in stock', v.stock; end if;
  update products set stock = stock + p_delta where id = p_product returning * into v;
  insert into movements (product_id, type, qty, note) values (p_product, p_type, p_delta, coalesce(p_note,''));
  return to_jsonb(v);
end $$;

-- ---------------------------------------------------------------------
-- Security: lock everything to the server's service_role key
-- ---------------------------------------------------------------------
alter table products  enable row level security;
alter table staff     enable row level security;
alter table orders    enable row level security;
alter table movements enable row level security;
alter table settings  enable row level security;
alter table checkins  enable row level security;
alter table messages  enable row level security;
alter table payments  enable row level security;
alter table expenses  enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on function create_order(jsonb), cancel_order(text), adjust_stock(text, integer, text, text) from public, anon, authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on function create_order(jsonb), cancel_order(text), adjust_stock(text, integer, text, text) to service_role;

-- Private bucket for staff selfies (viewed by owner through short-lived signed links)
insert into storage.buckets (id, name, public) values ('selfies', 'selfies', false) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Starting data (only inserted if missing). Change prices later in the dashboard.
-- ---------------------------------------------------------------------
insert into products (id, name, telugu, description, unit, price, stock, low_stock_at, emoji, tag, sort) values
  ('idly-batter', 'Idly Batter', 'ఇడ్లీ పిండి', 'Soft, fluffy idlis every time. Stone-ground from premium rice & urad dal, naturally fermented.', '1 kg pack', 80, 0, 10, '⚪', 'Bestseller', 1),
  ('dosa-batter', 'Dosa Batter', 'దోశ పిండి', 'Crispy golden dosas with that perfect tang. No soda, no preservatives.', '1 kg pack', 80, 0, 10, '🌕', 'Crispy', 2),
  ('millet-dosa', 'Millet Dosa Batter', 'చిరుధాన్యాల దోశ పిండి', 'Healthy mix of millets — high fibre, low GI, full of village goodness.', '1 kg pack', 110, 0, 8, '🌾', 'Healthy', 3),
  ('chapati', 'Chapati', 'చపాతీ', 'Ready-to-cook soft whole-wheat chapatis. Just heat on tawa and serve.', 'Pack of 10', 60, 0, 10, '🫓', 'Ready to cook', 4),
  ('poori', 'Poori', 'పూరీ', 'Ready-to-fry pooris that puff up golden every time.', 'Pack of 10', 60, 0, 10, '🥯', 'Ready to fry', 5)
on conflict (id) do nothing;

insert into settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;
