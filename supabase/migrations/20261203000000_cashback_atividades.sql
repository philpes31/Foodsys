-- =====================================================================
-- Balcão — cashback, pedido mínimo por bairro e registro de atividades da equipe
-- Rode depois de 20261202000000_adicionais_importacao.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Pedido mínimo por bairro (0 = vale só o mínimo geral da loja)
alter table public.zones add column if not exists min_order integer not null default 0 check (min_order between 0 and 10000000);
grant update (min_order) on public.zones to authenticated;
do $$ begin
  if exists (select 1 from information_schema.column_privileges where table_name = 'zones' and grantee = 'authenticated' and privilege_type = 'INSERT') then
    execute 'grant insert (min_order) on public.zones to authenticated';
  end if;
end $$;

-- 2. Cashback ----------------------------------------------------------------
alter table public.tenants add column if not exists cashback_percent integer not null default 0 check (cashback_percent between 0 and 30);
alter table public.tenants add column if not exists cashback_days integer not null default 90 check (cashback_days between 7 and 365);
grant select (cashback_percent, cashback_days) on public.tenants to anon, authenticated;
grant update (cashback_percent, cashback_days) on public.tenants to authenticated;
alter table public.orders add column if not exists cashback_used integer not null default 0 check (cashback_used >= 0);

-- Extrato por loja e telefone: ganho (+, vence), uso (−), estorno de uso (+) e estorno de ganho (−)
create table if not exists public.cashback_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_key text not null,
  order_id bigint references public.orders(id) on delete set null,
  amount integer not null,
  kind text not null check (kind in ('ganho', 'uso', 'estorno-uso', 'estorno-ganho')),
  expires_at timestamptz,
  at timestamptz not null default now()
);
create index if not exists cashback_ledger_key on public.cashback_ledger (tenant_id, phone_key);
create index if not exists cashback_ledger_order on public.cashback_ledger (order_id);
alter table public.cashback_ledger enable row level security;
drop policy if exists "dono vê cashback" on public.cashback_ledger;
create policy "dono vê cashback" on public.cashback_ledger for select to authenticated using (is_owner(tenant_id));
revoke all on public.cashback_ledger from anon, authenticated;
grant select on public.cashback_ledger to authenticated;

-- Saldo: ganhos ainda válidos + usos e estornos (nunca negativo). Interno: não é exposto direto (revelaria quem compra).
create or replace function public.cashback_balance(p_tenant uuid, p_phone text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(0, coalesce(sum(amount) filter (where kind <> 'ganho' or expires_at is null or expires_at > now()), 0))::int
  from cashback_ledger where tenant_id = p_tenant and phone_key = phone_key(p_phone) and phone_key(p_phone) <> ''
$$;
revoke execute on function public.cashback_balance(uuid, text) from public, anon, authenticated;

-- Ganha quando o pedido é entregue; cancelamento devolve o que foi usado e tira o que foi ganho.
create or replace function public._cashback_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; k text := phone_key(new.customer_phone); v int;
begin
  if new.status = old.status or k = '' then return new; end if;
  select * into t from tenants where id = new.tenant_id;
  if new.status = 'entregue' and t.cashback_percent > 0
     and not exists (select 1 from cashback_ledger where order_id = new.id and kind = 'ganho') then
    v := round(greatest(0, new.subtotal - new.discount - new.promo_discount - new.cashback_used) * t.cashback_percent / 100.0);
    if v > 0 then
      insert into cashback_ledger (tenant_id, phone_key, order_id, amount, kind, expires_at)
      values (new.tenant_id, k, new.id, v, 'ganho', now() + make_interval(days => t.cashback_days));
    end if;
  end if;
  if new.status = 'cancelado' then
    -- devolve o saldo usado e retira o que tinha ganhado (se já tinha sido entregue)
    insert into cashback_ledger (tenant_id, phone_key, order_id, amount, kind)
      select new.tenant_id, k, new.id, -sum(amount), 'estorno-uso' from cashback_ledger where order_id = new.id and kind in ('uso', 'estorno-uso')
      having sum(amount) < 0;
    insert into cashback_ledger (tenant_id, phone_key, order_id, amount, kind)
      select new.tenant_id, k, new.id, -sum(amount), 'estorno-ganho' from cashback_ledger where order_id = new.id and kind in ('ganho', 'estorno-ganho')
      having sum(amount) > 0;
  elsif old.status = 'cancelado' and new.cashback_used > 0 then
    -- voltou (Pix pago depois do prazo): usa o saldo de novo
    insert into cashback_ledger (tenant_id, phone_key, order_id, amount, kind) values (new.tenant_id, k, new.id, -new.cashback_used, 'uso');
  end if;
  return new;
end $$;
drop trigger if exists orders_cashback_on_status on public.orders;
create trigger orders_cashback_on_status after update of status on public.orders for each row execute function public._cashback_on_status();

CREATE OR REPLACE FUNCTION public._create_order(t tenants, p jsonb, p_check_min boolean DEFAULT true, p_status text DEFAULT 'novo'::text, p_channel text DEFAULT 'online'::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare
  v_name text := left(trim(coalesce(p->'customer'->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p->'customer'->>'phone', '')), 30);
  v_ful text := case p->>'fulfillment' when 'pickup' then 'pickup' when 'table' then 'table' else 'delivery' end;
  v_table text;
  v_pay text := p->>'payment';
  v_fee int := 0; v_zone text := ''; v_addr text := ''; v_zone_min int := 0; v_cb int := 0;
  z zones; c coupons; pr products; g option_groups; v_km numeric; v_lat double precision; v_lng double precision;
  v_coupon text; v_loy int := 0; v_every int; v_avail int; v_left int; v_pk text; v_sched timestamptz;
  pm promotions; v_promo int := 0; v_m int; v_n int; v_free int; v_pnames text[] := '{}';
  it jsonb; v_items jsonb := '[]'; v_qty int; v_unit int; v_labels text[]; v_chosen bigint[]; v_cnt int; v_add int;
  v_sub int := 0; v_disc int := 0; v_service int := 0; v_total int; v_change int; v_num int; o orders;
begin
  -- Uma venda por vez em cada loja: limites de cupom, fidelidade e numeração ficam corretos mesmo com muitos pedidos ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext(t.id::text));
  if p_channel not in ('online', 'balcao', 'telefone', 'mesa') then raise exception 'Canal inválido'; end if;
  -- telefone é obrigatório para entrega e para retirada feita pelo site; no balcão e na mesa é opcional
  if v_name = '' and p_channel = 'balcao' then v_name := 'Balcão'; end if;
  if v_name = '' then raise exception 'Informe o nome'; end if;
  if (v_ful = 'delivery' or (v_ful = 'pickup' and p_channel = 'online') or v_phone <> '')
     and length(regexp_replace(v_phone, '\D', '', 'g')) < 8 then raise exception 'Informe nome e telefone válidos'; end if;
  if v_ful = 'table' then
    if not t.allow_tables then raise exception 'Esta loja não atende pedidos na mesa'; end if;
    v_table := upper(trim(coalesce(p->>'table', '')));
    if v_table !~ '^[A-Z0-9][A-Z0-9 -]{0,9}$' then raise exception 'Mesa inválida'; end if;
    v_zone := 'Mesa ' || v_table;
  end if;
  if v_ful = 'pickup' and not t.allow_pickup then raise exception 'Esta loja não aceita retirada'; end if;
  if v_ful = 'delivery' then
    v_addr := left(trim(coalesce(p->>'address', '')), 200);
    if length(v_addr) < 5 then raise exception 'Informe o endereço de entrega'; end if;
    if t.delivery_mode = 'distance' then
      -- taxa por distância: calculada aqui, a partir da localização da loja e do endereço
      if coalesce(p->>'lat', '') !~ '^-?\d{1,2}(\.\d+)?$' or coalesce(p->>'lng', '') !~ '^-?\d{1,3}(\.\d+)?$' then
        raise exception 'Não conseguimos localizar o endereço. Confira o CEP e o número.';
      end if;
      v_lat := (p->>'lat')::double precision; v_lng := (p->>'lng')::double precision;
      if t.lat is null then raise exception 'A loja ainda não configurou a localização para entregas'; end if;
      v_km := round(haversine_km(t.lat, t.lng, v_lat, v_lng)::numeric, 1);
      v_fee := distance_fee(t.distance_tiers, v_km);
      if v_fee is null then raise exception 'Endereço fora da área de entrega (% km)', replace(v_km::text, '.', ','); end if;
      v_zone := replace(v_km::text, '.', ',') || ' km';
    else
      select * into z from zones where tenant_id = t.id and id::text = coalesce(p->>'zoneId', '');
      if not found then raise exception 'Escolha um bairro atendido'; end if;
      v_fee := z.fee; v_zone := z.name; v_zone_min := coalesce(z.min_order, 0);
    end if;
  end if;
  if v_pay is null or v_pay not in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa') then raise exception 'Forma de pagamento inválida'; end if;
  if v_pay = 'Pagar no caixa' and v_ful <> 'table' and p_channel = 'online' then raise exception 'Forma de pagamento inválida'; end if;
  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;
  if v_pay = 'Cartão online' and not t.card_online then raise exception 'Esta loja não aceita cartão online'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') not between 1 and 50 then raise exception 'Carrinho vazio'; end if;
  -- pedido agendado: horário entre a antecedência mínima e o limite de dias, dentro do funcionamento da loja
  if nullif(p->>'scheduledFor', '') is not null then
    if not t.allow_scheduling then raise exception 'Esta loja não aceita pedidos agendados'; end if;
    if p->>'scheduledFor' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' then raise exception 'Horário agendado inválido'; end if;
    v_sched := (p->>'scheduledFor')::timestamptz;
    if v_sched < now() + make_interval(mins => t.schedule_lead_minutes) then
      raise exception 'Agende com pelo menos % minutos de antecedência', t.schedule_lead_minutes;
    end if;
    if v_sched > now() + make_interval(days => t.schedule_days) then raise exception 'Dá para agendar com até % dia(s) de antecedência', t.schedule_days; end if;
    if closed_on(t, v_sched) then raise exception 'A loja estará fechada nesse dia. Escolha outra data.'; end if;
    if t.auto_hours and not store_open_at(t, v_sched) then raise exception 'A loja não funciona nesse horário. Escolha outro.'; end if;
  end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where tenant_id = t.id and id::text = coalesce(it->>'productId', '') and available;
    if not found then raise exception 'Um dos produtos não está mais disponível'; end if;
    if not category_open(t, pr.category, coalesce(v_sched, now())) then
      raise exception '"%" só é vendido %', pr.category, category_hours_text(t, pr.category);
    end if;
    if coalesce(it->>'qty', '') !~ '^\d{1,2}$' or (it->>'qty')::int < 1 then raise exception 'Quantidade inválida'; end if;
    v_qty := (it->>'qty')::int;
    if it->'optionIds' is not null and jsonb_typeof(it->'optionIds') <> 'array' then raise exception 'Opções inválidas'; end if;
    select coalesce(array_agg(distinct x::bigint), '{}') into v_chosen
      from jsonb_array_elements_text(coalesce(it->'optionIds', '[]')) x where x ~ '^\d{1,18}$';
    if cardinality(v_chosen) <> jsonb_array_length(coalesce(it->'optionIds', '[]')) then raise exception 'Opções inválidas'; end if;
    if exists (select 1 from unnest(v_chosen) x where x not in
        (select op.id from options op join option_groups og on og.id = op.group_id where og.product_id = pr.id)) then
      raise exception 'Opção inválida para o produto %', pr.name;
    end if;
    v_unit := pr.price; v_labels := '{}';
    for g in select * from option_groups where product_id = pr.id order by sort, id loop
      select count(*), coalesce(sum(price), 0) into v_cnt, v_add from options where group_id = g.id and id = any(v_chosen);
      if v_cnt < g.min_sel or v_cnt > g.max_sel then
        raise exception 'Escolha entre % e % em "%" (%)', g.min_sel, g.max_sel, g.name, pr.name;
      end if;
      v_unit := v_unit + v_add;
      v_labels := v_labels || array(select name from options where group_id = g.id and id = any(v_chosen) order by sort, id);
    end loop;
    -- estoque: baixa na hora (e devolve sozinho se o pedido for cancelado)
    if pr.stock is not null then
      update products set stock = stock - v_qty where id = pr.id and stock >= v_qty;
      if not found then
        select stock into v_left from products where id = pr.id;
        raise exception 'Só restam % unidade(s) de %', greatest(v_left, 0), pr.name;
      end if;
    end if;
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'product_name', pr.name, 'options_text', array_to_string(v_labels, ', '), 'option_names', to_jsonb(v_labels),
      'qty', v_qty, 'unit_price', v_unit, 'notes', left(coalesce(it->>'notes', ''), 140));
    v_sub := v_sub + v_qty * v_unit;
  end loop;

  if v_ful = 'delivery' and p_channel = 'online' and t.delivery_paused_until is not null and coalesce(v_sched, now()) < t.delivery_paused_until then
    raise exception 'Entregas pausadas até as %. Escolha retirada ou tente mais tarde.', to_char(t.delivery_paused_until at time zone t.timezone, 'HH24:MI');
  end if;
  if p_check_min and v_ful = 'delivery' and v_sub < t.min_order then raise exception 'Pedido abaixo do valor mínimo da loja'; end if;
  if p_check_min and v_ful = 'delivery' and v_zone_min > 0 and v_sub < v_zone_min then
    raise exception 'O pedido mínimo para % é R$ %', v_zone, replace(to_char(v_zone_min / 100.0, 'FM999990.00'), '.', ',');
  end if;
  -- frete grátis acima de um valor
  if v_ful = 'delivery' and t.free_delivery_above is not null and v_sub >= t.free_delivery_above then v_fee := 0; end if;
  -- promoções automáticas válidas no momento do pedido (ou no horário agendado)
  for pm in select * from promotions where tenant_id = t.id and active order by id loop
    if not promo_active(pm, t, coalesce(v_sched, now())) then continue; end if;
    if pm.kind = 'percent' then
      select coalesce(sum((x->>'qty')::int * (x->>'unit_price')::int), 0) into v_m
        from jsonb_array_elements(v_items) x join products pp on pp.id = (x->>'product_id')::bigint
        where (pm.product_id is null or pp.id = pm.product_id) and (pm.category is null or pp.category = pm.category);
      v_m := round(v_m * pm.percent / 100.0);
    else
      -- leve X, pague Y: as unidades mais baratas entre as participantes saem de graça
      select count(*) into v_n from jsonb_array_elements(v_items) x join products pp on pp.id = (x->>'product_id')::bigint
        cross join generate_series(1, (x->>'qty')::int)
        where (pm.product_id is null or pp.id = pm.product_id) and (pm.category is null or pp.category = pm.category);
      v_free := (v_n / pm.buy_qty) * (pm.buy_qty - pm.pay_qty);
      select coalesce(sum(u), 0) into v_m from (
        select (x->>'unit_price')::int u from jsonb_array_elements(v_items) x join products pp on pp.id = (x->>'product_id')::bigint
          cross join generate_series(1, (x->>'qty')::int)
          where (pm.product_id is null or pp.id = pm.product_id) and (pm.category is null or pp.category = pm.category)
          order by 1 limit v_free) f;
    end if;
    if v_m > 0 then v_promo := v_promo + v_m; v_pnames := v_pnames || pm.name; end if;
  end loop;
  v_promo := least(v_promo, v_sub);
  if coalesce(trim(p->>'coupon'), '') <> '' then
    select * into c from coupons where tenant_id = t.id and code = upper(trim(p->>'coupon')) and active;
    if not found then raise exception 'Cupom inválido'; end if;
    if c.valid_until is not null and c.valid_until < now() then raise exception 'Este cupom expirou'; end if;
    if v_sub < c.min_subtotal then raise exception 'Este cupom vale para pedidos a partir de R$ %', replace(to_char(c.min_subtotal / 100.0, 'FM9999990.00'), '.', ','); end if;
    if c.max_uses is not null and (select count(*) from orders where tenant_id = t.id and coupon_code = c.code and status <> 'cancelado') >= c.max_uses then
      raise exception 'Este cupom já atingiu o limite de usos';
    end if;
    v_pk := phone_key(v_phone);
    if (c.max_per_customer is not null or c.first_order_only) and length(v_pk) < 8 then raise exception 'Informe o telefone para usar este cupom'; end if;
    if c.max_per_customer is not null and (select count(*) from orders where tenant_id = t.id and coupon_code = c.code and status <> 'cancelado'
        and phone_key(customer_phone) = v_pk) >= c.max_per_customer then
      raise exception 'Você já usou este cupom o máximo de vezes';
    end if;
    if c.first_order_only and exists (select 1 from orders where tenant_id = t.id and status not in ('cancelado', 'pagamento') and phone_key(customer_phone) = v_pk) then
      raise exception 'Este cupom é só para a primeira compra';
    end if;
    v_disc := round(v_sub * c.percent / 100.0);
    if c.free_shipping then v_fee := 0; end if;
    v_coupon := c.code;
  end if;
  -- fidelidade: a cada N pedidos entregues, desconto no próximo (não soma com cupom: vale o maior)
  if t.loyalty_enabled and v_phone <> '' then
    v_avail := loyalty_stamps(t.id, v_phone);
    if v_avail >= t.loyalty_every then
      v_loy := round(v_sub * t.loyalty_percent / 100.0);
      if v_loy > v_disc then
        v_disc := v_loy;
        if v_coupon is not null and not c.free_shipping then v_coupon := null; end if;
      else v_loy := 0; end if;
    end if;
  end if;
  -- taxa de serviço (garçom): só na mesa, sobre o valor dos produtos com descontos; o cliente pode recusar (é opcional por lei)
  if v_ful = 'table' and coalesce(t.service_percent, 0) > 0 and coalesce(p->>'service', 'true') <> 'false' then
    v_service := round(greatest(0, v_sub - v_disc - v_promo) * t.service_percent / 100.0);
  end if;
  -- cashback: o cliente escolhe usar o saldo; desconta só dos produtos (já com os outros descontos)
  if coalesce(p->>'useCashback', 'false') = 'true' and phone_key(v_phone) <> '' then
    v_cb := least(cashback_balance(t.id, v_phone), greatest(0, v_sub - v_disc - v_promo));
  end if;
  v_total := greatest(0, v_sub + v_fee - v_disc - v_promo - v_cb) + v_service;
  if v_pay = 'Dinheiro' and coalesce(p->>'changeFor', '') ~ '^\d{1,8}$' and (p->>'changeFor')::int > v_total then
    v_change := (p->>'changeFor')::int;
  end if;

  select coalesce(max(number), 100) + 1 into v_num from orders where tenant_id = t.id;
  insert into orders (tenant_id, number, public_code, customer_name, customer_phone, fulfillment, address, zone_name, payment, change_for,
                      subtotal, fee, discount, total, coupon_code, status, payment_status, delivery_km, dest_lat, dest_lng, loyalty_discount, channel, table_label, scheduled_for,
                      promo_discount, promo_names, service_fee)
  values (t.id, v_num, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_name, v_phone, v_ful, v_addr, v_zone, v_pay, v_change,
          v_sub, v_fee, v_disc, v_total, v_coupon, p_status, case when v_pay in ('Pix online', 'Cartão online') then 'pending' else 'na' end, v_km, v_lat, v_lng, v_loy, p_channel, v_table, v_sched, v_promo, nullif(array_to_string(v_pnames, ', '), ''), v_service)
  returning * into o;
  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes, option_names)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes',
      array(select jsonb_array_elements_text(coalesce(x->'option_names', '[]')))
    from jsonb_array_elements(v_items) x;
  if v_cb > 0 then
    update orders set cashback_used = v_cb where id = o.id returning * into o;
    insert into cashback_ledger (tenant_id, phone_key, order_id, amount, kind) values (t.id, phone_key(v_phone), o.id, -v_cb, 'uso');
  end if;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $$;

CREATE OR REPLACE FUNCTION public.track_order(p_code text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
  select jsonb_build_object(
    'store', jsonb_build_object('slug', t.slug, 'name', t.name, 'color', t.color, 'phone', t.phone),
    'order', jsonb_build_object('number', o.number, 'status', o.status, 'fulfillment', o.fulfillment,
      'customerName', split_part(o.customer_name, ' ', 1), 'address', o.address, 'zone', o.zone_name, 'payment', o.payment,
      'paymentStatus', o.payment_status, 'scheduledFor', o.scheduled_for, 'promoDiscount', o.promo_discount, 'promoNames', o.promo_names,
      'review', (select jsonb_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply) from order_reviews r where r.order_id = o.id),
      'canReview', o.status = 'entregue' and o.updated_at > now() - interval '7 days' and not exists (select 1 from order_reviews r where r.order_id = o.id), 'loyaltyDiscount', o.loyalty_discount, 'cashbackUsed', o.cashback_used, 'km', o.delivery_km,
      'cashback', case when (t.cashback_percent > 0 or o.cashback_used > 0) and o.customer_phone <> 'removido' and phone_key(o.customer_phone) <> '' then jsonb_build_object(
                   'percent', t.cashback_percent, 'days', t.cashback_days,
                   'earned', (select coalesce(sum(amount), 0) from cashback_ledger l where l.order_id = o.id and l.kind in ('ganho', 'estorno-ganho')),
                   'willEarn', case when o.status not in ('entregue', 'cancelado') then round(greatest(0, o.subtotal - o.discount - o.promo_discount - o.cashback_used) * t.cashback_percent / 100.0) else 0 end,
                   'balance', cashback_balance(t.id, o.customer_phone)) end,
      'loyalty', case when t.loyalty_enabled and o.customer_phone <> 'removido' then jsonb_build_object('every', t.loyalty_every, 'percent', t.loyalty_percent,
                   'stamps', loyalty_stamps(t.id, o.customer_phone)) end,
      'pix', case when o.status = 'pagamento' and o.pix_qr is not null
                  then jsonb_build_object('qr', o.pix_qr, 'qrBase64', o.pix_qr_base64, 'expiresAt', o.pix_expires_at) end,
      'subtotal', o.subtotal, 'fee', o.fee, 'serviceFee', o.service_fee, 'discount', o.discount, 'total', o.total, 'coupon', o.coupon_code,
      'courier', case when o.status = 'rota' then cr.name end,
      'etaAt', case when o.status in ('novo', 'preparo') or (o.status in ('pronto', 'rota') and o.fulfillment = 'delivery')
                    then coalesce(o.scheduled_for, o.created_at) + make_interval(mins => typical_minutes(t.id, o.fulfillment)) end,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('product_name', i.product_name, 'options_text', i.options_text, 'qty', i.qty,
                 'unit_price', i.unit_price, 'notes', i.notes) order by i.id), '[]') from order_items i where i.order_id = o.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'at', e.at) order by e.id), '[]') from order_events e where e.order_id = o.id)))
  from orders o join tenants t on t.id = o.tenant_id left join couriers cr on cr.id = o.courier_id
  where o.public_code = upper(trim(p_code))
$$;

-- 3. Registro de atividades da equipe (o dono vê quem fez o quê) --------------
create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  at timestamptz not null default now(),
  user_id uuid,
  email text,
  action text not null,
  detail text
);
create index if not exists activity_log_tenant_at on public.activity_log (tenant_id, at desc);
alter table public.activity_log enable row level security;
drop policy if exists "dono vê atividades" on public.activity_log;
create policy "dono vê atividades" on public.activity_log for select to authenticated using (is_owner(tenant_id));
revoke all on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;

-- Só registra o que uma pessoa fez pelo painel (auth.uid() presente); ações automáticas ficam de fora.
create or replace function public._log(p_tenant uuid, p_action text, p_detail text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_tenant is null then return; end if;
  if not exists (select 1 from tenants where id = p_tenant) then return; end if;   -- loja sendo excluída
  insert into activity_log (tenant_id, user_id, email, action, detail)
    values (p_tenant, auth.uid(), (select email from auth.users where id = auth.uid()), p_action, left(p_detail, 300));
  if random() < 0.005 then delete from activity_log where at < now() - interval '180 days'; end if;
end $$;
revoke execute on function public._log(uuid, text, text) from public, anon, authenticated;

create or replace function public._money(c int) returns text language sql immutable as $$ select 'R$ ' || replace(to_char(coalesce(c, 0) / 100.0, 'FM999990.00'), '.', ',') $$;

create or replace function public._audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'products' then
    if tg_op = 'INSERT' then perform _log(new.tenant_id, 'Produto criado', new.name || ' · ' || _money(new.price));
    elsif tg_op = 'DELETE' then perform _log(old.tenant_id, 'Produto excluído', old.name);
    else
      if new.price <> old.price then perform _log(new.tenant_id, 'Preço alterado', new.name || ': ' || _money(old.price) || ' → ' || _money(new.price)); end if;
      if new.available <> old.available then perform _log(new.tenant_id, case when new.available then 'Produto disponível' else 'Produto esgotado' end, new.name); end if;
    end if;
  elsif tg_table_name = 'orders' then
    if new.status = 'cancelado' and old.status <> 'cancelado' then perform _log(new.tenant_id, 'Pedido cancelado', '#' || new.number || ' · ' || new.customer_name || ' · ' || _money(new.total)); end if;
    if old.status = 'cancelado' and new.status <> 'cancelado' then perform _log(new.tenant_id, 'Pedido reaberto', '#' || new.number); end if;
  elsif tg_table_name = 'coupons' then
    if tg_op = 'INSERT' then perform _log(new.tenant_id, 'Cupom criado', new.code);
    elsif tg_op = 'DELETE' then perform _log(old.tenant_id, 'Cupom excluído', old.code);
    elsif new.active <> old.active then perform _log(new.tenant_id, case when new.active then 'Cupom ativado' else 'Cupom desativado' end, new.code); end if;
  elsif tg_table_name = 'cash_sessions' then
    if tg_op = 'INSERT' then perform _log(new.tenant_id, 'Caixa aberto', 'troco ' || _money(new.opening_amount));
    elsif new.closed_at is not null and old.closed_at is null then
      perform _log(new.tenant_id, 'Caixa fechado', 'esperado ' || _money(new.expected_amount) || ' · contado ' || _money(new.counted_amount)
        || case when new.counted_amount <> new.expected_amount then ' · diferença ' || _money(new.counted_amount - new.expected_amount) else '' end);
    end if;
  elsif tg_table_name = 'cash_moves' then
    perform _log(new.tenant_id, case when new.kind = 'sangria' then 'Sangria' else 'Reforço de caixa' end, _money(new.amount) || coalesce(' · ' || new.note, ''));
  elsif tg_table_name = 'memberships' then
    if tg_op = 'INSERT' then perform _log(new.tenant_id, 'Pessoa adicionada à equipe', coalesce((select email from auth.users where id = new.user_id), '?') || ' (' || new.role || ')');
    else perform _log(old.tenant_id, 'Pessoa removida da equipe', coalesce((select email from auth.users where id = old.user_id), '?')); end if;
  elsif tg_table_name = 'blocked_phones' then
    if tg_op = 'INSERT' then perform _log(new.tenant_id, 'Cliente bloqueado', '…' || right(new.phone_key, 4) || coalesce(' · ' || new.note, ''));
    else perform _log(old.tenant_id, 'Cliente desbloqueado', '…' || right(old.phone_key, 4)); end if;
  elsif tg_table_name = 'expenses' then
    if tg_op = 'INSERT' then perform _log(new.tenant_id, 'Despesa lançada', new.category || ' · ' || _money(new.amount));
    else perform _log(old.tenant_id, 'Despesa excluída', old.category || ' · ' || _money(old.amount)); end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists audit_products on public.products;
create trigger audit_products after insert or update of price, available or delete on public.products for each row execute function public._audit();
drop trigger if exists audit_orders on public.orders;
create trigger audit_orders after update of status on public.orders for each row execute function public._audit();
drop trigger if exists audit_coupons on public.coupons;
create trigger audit_coupons after insert or update of active or delete on public.coupons for each row execute function public._audit();
drop trigger if exists audit_cash_sessions on public.cash_sessions;
create trigger audit_cash_sessions after insert or update on public.cash_sessions for each row execute function public._audit();
drop trigger if exists audit_cash_moves on public.cash_moves;
create trigger audit_cash_moves after insert on public.cash_moves for each row execute function public._audit();
drop trigger if exists audit_memberships on public.memberships;
create trigger audit_memberships after insert or delete on public.memberships for each row execute function public._audit();
drop trigger if exists audit_blocked on public.blocked_phones;
create trigger audit_blocked after insert or delete on public.blocked_phones for each row execute function public._audit();
drop trigger if exists audit_expenses on public.expenses;
create trigger audit_expenses after insert or delete on public.expenses for each row execute function public._audit();

-- Checagem das migrações: inclui esta.
create or replace function public.schema_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  select jsonb_agg(jsonb_build_object('n', n, 'file', file, 'ok', ok) order by n) into r
  from (values
    (1,  '20261113000000_balcao.sql',                     to_regclass('public.tenants') is not null),
    (2,  '20261114000000_horarios_fotos.sql',             exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants'  and column_name = 'hours')),
    (3,  '20261115000000_pix_online.sql',                 exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders'   and column_name = 'payment_status')),
    (4,  '20261116000000_assinaturas.sql',                exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants'  and column_name = 'billing_status')),
    (5,  '20261117000000_entregador_clientes_lgpd.sql',   exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'couriers' and column_name = 'access_token')),
    (6,  '20261118000000_distancia_fidelidade.sql',       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants'  and column_name = 'delivery_mode')),
    (7,  '20261119000000_balcao_mesa_caixa.sql',          to_regprocedure('public.cash_report(uuid, date)') is not null),
    (8,  '20261120000000_cupons_avaliacoes_estoque.sql',  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'coupons'  and column_name = 'min_subtotal')),
    (9,  '20261121000000_agendamento_vitrine.sql',        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders'   and column_name = 'scheduled_for')),
    (10, '20261122000000_promocoes.sql',                  to_regclass('public.promotions') is not null),
    (11, '20261123000000_checagem.sql',                   true),
    (12, '20261124000000_saude_plataforma.sql',           to_regprocedure('public.platform_health(integer)') is not null),
    (13, '20261125000000_cartao_dominio_unidades.sql',    to_regprocedure('public.create_unit(uuid, text, text)') is not null),
    (14, '20261126000000_seguranca.sql',                  to_regclass('public.rate_hits') is not null),
    (15, '20261127000000_mesa_servico_pedidos_antigos.sql', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'service_fee')),
    (16, '20261128000000_vitrine_previsao_mesas.sql',     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'settled_at')),
    (17, '20261129000000_pausa_feriados_estacoes.sql',    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'stations')),
    (18, '20261130000000_caixa_acerto_bloqueio.sql',      to_regclass('public.cash_sessions') is not null),
    (19, '20261201000000_insumos_financeiro.sql',         to_regclass('public.ingredients') is not null),
    (20, '20261202000000_adicionais_importacao.sql',      to_regclass('public.option_ingredients') is not null),
    (21, '20261203000000_cashback_atividades.sql',        to_regclass('public.cashback_ledger') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
