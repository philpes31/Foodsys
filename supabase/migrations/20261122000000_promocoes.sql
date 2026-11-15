-- =====================================================================
-- Balcão — promoções automáticas e frete grátis acima de um valor
-- Rode depois de 20261121000000_agendamento_vitrine.sql
-- =====================================================================

alter table public.tenants add column free_delivery_above integer check (free_delivery_above > 0);
grant update (free_delivery_above) on public.tenants to authenticated;

-- Promoções: "leve X, pague Y" ou "% de desconto", num produto, numa categoria ou na loja toda,
-- opcionalmente só em alguns dias da semana e numa faixa de horário (ex.: happy hour).
create table public.promotions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  kind text not null check (kind in ('buy_x_pay_y', 'percent')),
  product_id bigint references public.products(id) on delete cascade,
  category text check (length(category) <= 40),
  buy_qty integer check (buy_qty between 2 and 20),
  pay_qty integer check (pay_qty >= 1),
  percent integer check (percent between 1 and 90),
  days integer[] check (days <@ array[0, 1, 2, 3, 4, 5, 6]),
  start_time time,
  end_time time,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((kind = 'percent' and percent is not null) or (kind = 'buy_x_pay_y' and buy_qty is not null and pay_qty is not null and pay_qty < buy_qty)),
  check ((start_time is null) = (end_time is null) and (start_time is null or start_time <> end_time))
);
create index on public.promotions (tenant_id) where active;
alter table public.promotions enable row level security;
revoke all on public.promotions from anon, authenticated;
grant select on public.promotions to anon, authenticated;
grant insert, delete on public.promotions to authenticated;
grant update (name, kind, product_id, category, buy_qty, pay_qty, percent, days, start_time, end_time, active) on public.promotions to authenticated;
create policy "ver promoções" on public.promotions for select using (tenant_is_public(tenant_id) or is_member(tenant_id));
create policy "dono cria promoção" on public.promotions for insert with check (is_owner(tenant_id)
  and (product_id is null or exists (select 1 from products p where p.id = product_id and p.tenant_id = promotions.tenant_id)));
create policy "dono edita promoção" on public.promotions for update using (is_owner(tenant_id)) with check (is_owner(tenant_id)
  and (product_id is null or exists (select 1 from products p where p.id = product_id and p.tenant_id = promotions.tenant_id)));
create policy "dono apaga promoção" on public.promotions for delete using (is_owner(tenant_id));

-- A promoção vale neste instante (no fuso da loja)?
create function public.promo_active(pm public.promotions, t public.tenants, p_at timestamptz) returns boolean
language sql stable as $$
  select pm.active
    and (pm.days is null or cardinality(pm.days) = 0 or extract(dow from p_at at time zone t.timezone)::int = any(pm.days))
    and (pm.start_time is null
         or (pm.start_time < pm.end_time and (p_at at time zone t.timezone)::time >= pm.start_time and (p_at at time zone t.timezone)::time < pm.end_time)
         or (pm.start_time > pm.end_time and ((p_at at time zone t.timezone)::time >= pm.start_time or (p_at at time zone t.timezone)::time < pm.end_time)))
$$;

alter table public.orders
  add column promo_discount integer not null default 0,
  add column promo_names text;

create or replace function public._create_order(t public.tenants, p jsonb, p_check_min boolean default true, p_status text default 'novo', p_channel text default 'online') returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p->'customer'->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p->'customer'->>'phone', '')), 30);
  v_ful text := case p->>'fulfillment' when 'pickup' then 'pickup' when 'table' then 'table' else 'delivery' end;
  v_table text;
  v_pay text := p->>'payment';
  v_fee int := 0; v_zone text := ''; v_addr text := '';
  z zones; c coupons; pr products; g option_groups; v_km numeric; v_lat double precision; v_lng double precision;
  v_coupon text; v_loy int := 0; v_every int; v_avail int; v_left int; v_pk text; v_sched timestamptz;
  pm promotions; v_promo int := 0; v_m int; v_n int; v_free int; v_pnames text[] := '{}';
  it jsonb; v_items jsonb := '[]'; v_qty int; v_unit int; v_labels text[]; v_chosen bigint[]; v_cnt int; v_add int;
  v_sub int := 0; v_disc int := 0; v_total int; v_change int; v_num int; o orders;
begin
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
      v_fee := z.fee; v_zone := z.name;
    end if;
  end if;
  if v_pay is null or v_pay not in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Pagar no caixa') then raise exception 'Forma de pagamento inválida'; end if;
  if v_pay = 'Pagar no caixa' and v_ful <> 'table' and p_channel = 'online' then raise exception 'Forma de pagamento inválida'; end if;
  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;
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
    if t.auto_hours and not store_open_at(t, v_sched) then raise exception 'A loja não funciona nesse horário. Escolha outro.'; end if;
  end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from products where tenant_id = t.id and id::text = coalesce(it->>'productId', '') and available;
    if not found then raise exception 'Um dos produtos não está mais disponível'; end if;
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
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'product_name', pr.name, 'options_text', array_to_string(v_labels, ', '),
      'qty', v_qty, 'unit_price', v_unit, 'notes', left(coalesce(it->>'notes', ''), 140));
    v_sub := v_sub + v_qty * v_unit;
  end loop;

  if p_check_min and v_ful = 'delivery' and v_sub < t.min_order then raise exception 'Pedido abaixo do valor mínimo da loja'; end if;
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
  v_total := greatest(0, v_sub + v_fee - v_disc - v_promo);
  if v_pay = 'Dinheiro' and coalesce(p->>'changeFor', '') ~ '^\d{1,8}$' and (p->>'changeFor')::int > v_total then
    v_change := (p->>'changeFor')::int;
  end if;

  perform pg_advisory_xact_lock(hashtext(t.id::text));
  select coalesce(max(number), 100) + 1 into v_num from orders where tenant_id = t.id;
  insert into orders (tenant_id, number, public_code, customer_name, customer_phone, fulfillment, address, zone_name, payment, change_for,
                      subtotal, fee, discount, total, coupon_code, status, payment_status, delivery_km, dest_lat, dest_lng, loyalty_discount, channel, table_label, scheduled_for,
                      promo_discount, promo_names)
  values (t.id, v_num, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_name, v_phone, v_ful, v_addr, v_zone, v_pay, v_change,
          v_sub, v_fee, v_disc, v_total, v_coupon, p_status, case when v_pay = 'Pix online' then 'pending' else 'na' end, v_km, v_lat, v_lng, v_loy, p_channel, v_table, v_sched, v_promo, nullif(array_to_string(v_pnames, ', '), ''))
  returning * into o;
  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes'
    from jsonb_array_elements(v_items) x;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $$;

create or replace function public.track_order(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'store', jsonb_build_object('slug', t.slug, 'name', t.name, 'color', t.color, 'phone', t.phone),
    'order', jsonb_build_object('number', o.number, 'status', o.status, 'fulfillment', o.fulfillment,
      'customerName', split_part(o.customer_name, ' ', 1), 'address', o.address, 'zone', o.zone_name, 'payment', o.payment,
      'paymentStatus', o.payment_status, 'scheduledFor', o.scheduled_for, 'promoDiscount', o.promo_discount, 'promoNames', o.promo_names,
      'review', (select jsonb_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply) from order_reviews r where r.order_id = o.id),
      'canReview', o.status = 'entregue' and o.updated_at > now() - interval '7 days' and not exists (select 1 from order_reviews r where r.order_id = o.id), 'loyaltyDiscount', o.loyalty_discount, 'km', o.delivery_km,
      'loyalty', case when t.loyalty_enabled and o.customer_phone <> 'removido' then jsonb_build_object('every', t.loyalty_every, 'percent', t.loyalty_percent,
                   'stamps', loyalty_stamps(t.id, o.customer_phone)) end,
      'pix', case when o.status = 'pagamento' and o.pix_qr is not null
                  then jsonb_build_object('qr', o.pix_qr, 'qrBase64', o.pix_qr_base64, 'expiresAt', o.pix_expires_at) end,
      'subtotal', o.subtotal, 'fee', o.fee, 'discount', o.discount, 'total', o.total, 'coupon', o.coupon_code,
      'courier', case when o.status = 'rota' then cr.name end,
      'items', (select coalesce(jsonb_agg(jsonb_build_object('product_name', i.product_name, 'options_text', i.options_text, 'qty', i.qty,
                 'unit_price', i.unit_price, 'notes', i.notes) order by i.id), '[]') from order_items i where i.order_id = o.id),
      'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'at', e.at) order by e.id), '[]') from order_events e where e.order_id = o.id)))
  from orders o join tenants t on t.id = o.tenant_id left join couriers cr on cr.id = o.courier_id
  where o.public_code = upper(trim(p_code))
$$;

create or replace function public.cash_report(p_tenant uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t tenants; v_day date; v_from timestamptz; v_to timestamptz; r jsonb;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  v_day := coalesce(p_day, (now() at time zone t.timezone)::date);
  v_from := v_day::timestamp at time zone t.timezone;
  v_to := (v_day + 1)::timestamp at time zone t.timezone;
  with o as (select * from orders where tenant_id = p_tenant and created_at >= v_from and created_at < v_to and status <> 'pagamento'),
       ok as (select * from o where status <> 'cancelado')
  select jsonb_build_object(
    'day', v_day,
    'orders', (select count(*) from ok),
    'subtotal', (select coalesce(sum(subtotal), 0) from ok),
    'fees', (select coalesce(sum(fee), 0) from ok),
    'discounts', (select coalesce(sum(discount + promo_discount), 0) from ok),
    'total', (select coalesce(sum(total), 0) from ok),
    'open', (select count(*) from ok where status not in ('entregue')),
    'cancelled', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(total), 0)) from o where status = 'cancelado'),
    'paidOnline', (select coalesce(sum(total), 0) from ok where payment_status = 'paid'),
    'byPayment', (select coalesce(jsonb_agg(jsonb_build_object('payment', payment, 'count', n, 'total', s) order by s desc), '[]')
                  from (select payment, count(*) n, sum(total) s from ok group by payment) x),
    'byChannel', (select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'count', n, 'total', s) order by s desc), '[]')
                  from (select channel, count(*) n, sum(total) s from ok group by channel) x),
    'byFulfillment', (select coalesce(jsonb_agg(jsonb_build_object('fulfillment', fulfillment, 'count', n, 'total', s) order by s desc), '[]')
                  from (select fulfillment, count(*) n, sum(total) s from ok group by fulfillment) x),
    'cashChange', (select coalesce(sum(change_for - total), 0) from ok where payment = 'Dinheiro' and change_for is not null)
  ) into r;
  return r;
end $$;

revoke execute on function public.promo_active(public.promotions, public.tenants, timestamptz) from public, anon;
