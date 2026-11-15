-- =====================================================================
-- Balcão — pedido no balcão/telefone, pedido na mesa (QR Code) e fechamento de caixa
-- Rode depois de 20261118000000_distancia_fidelidade.sql
-- =====================================================================

alter table public.tenants
  add column allow_tables boolean not null default false,
  add column tables_count integer not null default 10 check (tables_count between 1 and 200);
grant update (allow_tables, tables_count) on public.tenants to authenticated;

alter table public.orders drop constraint orders_fulfillment_check;
alter table public.orders add constraint orders_fulfillment_check check (fulfillment in ('delivery', 'pickup', 'table'));
alter table public.orders drop constraint orders_payment_check;
alter table public.orders add constraint orders_payment_check check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Pagar no caixa'));
alter table public.orders
  add column channel text not null default 'online' check (channel in ('online', 'balcao', 'telefone', 'mesa')),
  add column table_label text;

drop function public._create_order(public.tenants, jsonb, boolean, text);

create function public._create_order(t public.tenants, p jsonb, p_check_min boolean default true, p_status text default 'novo', p_channel text default 'online') returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p->'customer'->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p->'customer'->>'phone', '')), 30);
  v_ful text := case p->>'fulfillment' when 'pickup' then 'pickup' when 'table' then 'table' else 'delivery' end;
  v_table text;
  v_pay text := p->>'payment';
  v_fee int := 0; v_zone text := ''; v_addr text := '';
  z zones; c coupons; pr products; g option_groups; v_km numeric; v_lat double precision; v_lng double precision;
  v_coupon text; v_loy int := 0; v_every int; v_avail int;
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
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'product_name', pr.name, 'options_text', array_to_string(v_labels, ', '),
      'qty', v_qty, 'unit_price', v_unit, 'notes', left(coalesce(it->>'notes', ''), 140));
    v_sub := v_sub + v_qty * v_unit;
  end loop;

  if p_check_min and v_ful = 'delivery' and v_sub < t.min_order then raise exception 'Pedido abaixo do valor mínimo da loja'; end if;
  if coalesce(trim(p->>'coupon'), '') <> '' then
    select * into c from coupons where tenant_id = t.id and code = upper(trim(p->>'coupon')) and active;
    if not found then raise exception 'Cupom inválido'; end if;
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
  v_total := v_sub + v_fee - v_disc;
  if v_pay = 'Dinheiro' and coalesce(p->>'changeFor', '') ~ '^\d{1,8}$' and (p->>'changeFor')::int > v_total then
    v_change := (p->>'changeFor')::int;
  end if;

  perform pg_advisory_xact_lock(hashtext(t.id::text));
  select coalesce(max(number), 100) + 1 into v_num from orders where tenant_id = t.id;
  insert into orders (tenant_id, number, public_code, customer_name, customer_phone, fulfillment, address, zone_name, payment, change_for,
                      subtotal, fee, discount, total, coupon_code, status, payment_status, delivery_km, dest_lat, dest_lng, loyalty_discount, channel, table_label)
  values (t.id, v_num, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_name, v_phone, v_ful, v_addr, v_zone, v_pay, v_change,
          v_sub, v_fee, v_disc, v_total, v_coupon, p_status, case when v_pay = 'Pix online' then 'pending' else 'na' end, v_km, v_lat, v_lng, v_loy, p_channel, v_table)
  returning * into o;
  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes'
    from jsonb_array_elements(v_items) x;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $$;

create or replace function public.place_order(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; v_limit int; o orders;
begin
  select * into t from tenants where slug = p_slug and active;
  if not found then raise exception 'Loja não encontrada'; end if;
  if not billing_ok(t) then raise exception 'Esta loja está temporariamente indisponível'; end if;
  if not store_open_at(t) then raise exception 'A loja está fechada no momento'; end if;
  select monthly_orders into v_limit from plans where name = t.plan;
  if v_limit is not null and (select count(*) from orders where tenant_id = t.id and status <> 'pagamento'
      and created_at >= (date_trunc('month', now() at time zone t.timezone) at time zone t.timezone)) >= v_limit then
    raise exception 'A loja atingiu o limite de pedidos do plano neste mês';
  end if;
  o := _create_order(t, p, true, case when p->>'payment' = 'Pix online' then 'pagamento' else 'novo' end,
                    case when p->>'fulfillment' = 'table' then 'mesa' else 'online' end);
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'pix', o.payment = 'Pix online');
end $$;

-- Pedido lançado pela equipe no painel (balcão, telefone ou mesa). Não depende do horário do site; já entra em preparo.
create function public.staff_place_order(p_tenant uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; o orders; v_channel text := coalesce(p->>'channel', 'balcao');
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  if not billing_ok(t) then raise exception 'Assinatura pendente: regularize para lançar pedidos'; end if;
  if v_channel not in ('balcao', 'telefone', 'mesa') then raise exception 'Canal inválido'; end if;
  if p->>'payment' = 'Pix online' then raise exception 'No painel, use Pix, cartão, dinheiro ou pagar no caixa'; end if;
  o := _create_order(t, p, false, 'preparo', v_channel);
  return jsonb_build_object('id', o.id, 'code', o.public_code, 'number', o.number, 'total', o.total);
end $$;

-- Fechamento de caixa de um dia (no fuso da loja)
create function public.cash_report(p_tenant uuid, p_day date default null) returns jsonb
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
    'discounts', (select coalesce(sum(discount), 0) from ok),
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

revoke execute on function public._create_order(public.tenants, jsonb, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.staff_place_order(uuid, jsonb), public.cash_report(uuid, date) from public, anon;
grant execute on function public.staff_place_order(uuid, jsonb), public.cash_report(uuid, date) to authenticated;
