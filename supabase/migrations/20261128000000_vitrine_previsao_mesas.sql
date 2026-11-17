-- =====================================================================
-- Balcão — mais pedidos, previsão de entrega, categorias com horário e conta da mesa
-- Rode depois de 20261127000000_mesa_servico_pedidos_antigos.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Categorias com horário: {"Café da manhã": {"from": "06:00", "to": "11:00", "days": [1,2,3,4,5]}}
--    (days opcional, 0 = domingo; "to" menor que "from" atravessa a meia-noite)
alter table public.tenants add column if not exists category_hours jsonb not null default '{}'::jsonb
  check (jsonb_typeof(category_hours) = 'object');
grant select (category_hours) on public.tenants to anon, authenticated;
grant update (category_hours) on public.tenants to authenticated;

create or replace function public.category_open(t public.tenants, p_cat text, p_at timestamptz) returns boolean
language plpgsql stable set search_path = public, pg_temp as $$
declare h jsonb := t.category_hours -> p_cat; v_from time; v_to time; v_now time; v_dow int;
begin
  if h is null or jsonb_typeof(h) <> 'object' then return true; end if;
  v_now := (p_at at time zone t.timezone)::time; v_dow := extract(dow from p_at at time zone t.timezone)::int;
  if jsonb_typeof(h->'days') = 'array' and jsonb_array_length(h->'days') > 0
     and not exists (select 1 from jsonb_array_elements_text(h->'days') d where d = v_dow::text) then return false; end if;
  begin v_from := (h->>'from')::time; v_to := (h->>'to')::time; exception when others then return true; end;
  if v_from is null or v_to is null or v_from = v_to then return true; end if;
  return case when v_from < v_to then v_now >= v_from and v_now < v_to else v_now >= v_from or v_now < v_to end;
end $$;

create or replace function public.category_hours_text(t public.tenants, p_cat text) returns text
language sql stable set search_path = public, pg_temp as $$
  select 'das ' || coalesce(t.category_hours -> p_cat ->> 'from', '?') || ' às ' || coalesce(t.category_hours -> p_cat ->> 'to', '?')
    || case when jsonb_array_length(coalesce(t.category_hours -> p_cat -> 'days', '[]')) between 1 and 6
            then ' (' || (select string_agg((array['dom','seg','ter','qua','qui','sex','sáb'])[d::int + 1], ', ' order by d::int)
                         from jsonb_array_elements_text(t.category_hours -> p_cat -> 'days') d) || ')' else '' end
$$;

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
  v_fee int := 0; v_zone text := ''; v_addr text := '';
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
      v_fee := z.fee; v_zone := z.name;
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
  -- taxa de serviço (garçom): só na mesa, sobre o valor dos produtos com descontos; o cliente pode recusar (é opcional por lei)
  if v_ful = 'table' and coalesce(t.service_percent, 0) > 0 and coalesce(p->>'service', 'true') <> 'false' then
    v_service := round(greatest(0, v_sub - v_disc - v_promo) * t.service_percent / 100.0);
  end if;
  v_total := greatest(0, v_sub + v_fee - v_disc - v_promo) + v_service;
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
  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes'
    from jsonb_array_elements(v_items) x;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $$;

-- 2. Previsão: tempo típico (mediana) dos pedidos da loja nos últimos 30 dias, até ficar pronto (retirada/mesa)
--    ou até ser entregue (entrega). Sem histórico suficiente (menos de 5 pedidos) devolve nulo e o site mostra o texto da loja.
create or replace function public.typical_minutes(p_tenant uuid, p_fulfillment text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select case when count(*) >= 5 then greatest(5, round(percentile_cont(0.5) within group (order by m))::int) end
  from (
    select extract(epoch from (e.at - o.created_at)) / 60 m
    from orders o join lateral (select min(at) at from order_events e where e.order_id = o.id
                                 and e.status = case when p_fulfillment = 'delivery' then 'entregue' else 'pronto' end) e on e.at is not null
    where o.tenant_id = p_tenant and o.fulfillment = p_fulfillment and o.scheduled_for is null
      and o.created_at > now() - interval '30 days'
    order by o.created_at desc limit 300
  ) x where m between 1 and 240
$$;
revoke execute on function public.typical_minutes(uuid, text) from public, anon, authenticated;

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
      'canReview', o.status = 'entregue' and o.updated_at > now() - interval '7 days' and not exists (select 1 from order_reviews r where r.order_id = o.id), 'loyaltyDiscount', o.loyalty_discount, 'km', o.delivery_km,
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

-- Previsão para quem está escolhendo na loja (sem pedido ainda)
create or replace function public.store_eta(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('delivery', typical_minutes(t.id, 'delivery'), 'pickup', typical_minutes(t.id, 'pickup'))
  from tenants t where t.slug = p_slug and t.active
$$;

-- 3. Mais pedidos: os campeões de venda dos últimos 30 dias (só produtos com 3+ pedidos)
create or replace function public.popular_products(p_slug text, p_limit int default 6) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(product_id order by q desc), '[]') from (
    select i.product_id, sum(i.qty) q
    from tenants t join orders o on o.tenant_id = t.id join order_items i on i.order_id = o.id
    join products p on p.id = i.product_id and p.available
    where t.slug = p_slug and t.active and o.status not in ('cancelado', 'pagamento') and o.created_at > now() - interval '30 days'
    group by i.product_id having count(distinct o.id) >= 3
    order by q desc limit least(greatest(coalesce(p_limit, 6), 1), 12)
  ) x
$$;
grant execute on function public.store_eta(text), public.popular_products(text, int) to anon, authenticated;

-- 4. Conta da mesa: os pedidos de cada mesa até o fechamento da conta
alter table public.orders add column if not exists settled_at timestamptz;

create or replace function public.open_tables(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  return (select coalesce(jsonb_agg(x order by x->>'since'), '[]') from (
    select jsonb_build_object('table', o.table_label, 'since', min(o.created_at),
      'orders', jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'paid', o.payment_status = 'paid', 'total', o.total) order by o.id),
      'subtotal', sum(o.subtotal), 'service', sum(o.service_fee), 'discount', sum(o.discount + o.promo_discount + o.loyalty_discount), 'total', sum(o.total),
      'paidOnline', sum(case when o.payment_status = 'paid' then o.total else 0 end),
      'pending', count(*) filter (where o.status in ('novo', 'preparo')),
      'items', (select jsonb_agg(jsonb_build_object('name', i.product_name, 'options', i.options_text, 'qty', i.qty, 'unit', i.unit_price) order by i.id)
                from order_items i where i.order_id = any(array_agg(o.id)))) x
    from orders o
    where o.tenant_id = p_tenant and o.fulfillment = 'table' and o.settled_at is null
      and o.status not in ('cancelado', 'pagamento') and o.created_at > now() - interval '24 hours'
    group by o.table_label) s);
end $$;

create or replace function public.close_table(p_tenant uuid, p_table text, p_payment text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if p_payment not in ('Dinheiro', 'Pix', 'Cartão na entrega') then raise exception 'Forma de pagamento inválida'; end if;
  update orders set settled_at = now(), updated_at = now(),
    payment = case when payment_status = 'paid' then payment else p_payment end,
    status = 'entregue'
  where tenant_id = p_tenant and fulfillment = 'table' and table_label = upper(trim(p_table)) and settled_at is null
    and status not in ('cancelado', 'pagamento') and created_at > now() - interval '24 hours';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Nenhum pedido aberto nessa mesa'; end if;
  insert into order_events (order_id, tenant_id, status)
    select o.id, p_tenant, 'entregue' from orders o
    where o.tenant_id = p_tenant and o.table_label = upper(trim(p_table)) and o.settled_at = now()
      and not exists (select 1 from order_events e where e.order_id = o.id and e.status = 'entregue');
  return n;
end $$;
revoke execute on function public.open_tables(uuid), public.close_table(uuid, text, text) from public, anon;
grant execute on function public.open_tables(uuid), public.close_table(uuid, text, text) to authenticated;

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
    (16, '20261128000000_vitrine_previsao_mesas.sql',     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'settled_at'))
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
