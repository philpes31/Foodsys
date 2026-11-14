-- =====================================================================
-- Balcão — taxa de entrega por distância e programa de fidelidade
-- Rode depois de 20261117000000_entregador_clientes_lgpd.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Entrega por distância: a loja marca a própria localização e define faixas, ex.:
--   [[2, 500], [5, 800], [8, 1200]]  = até 2 km R$ 5,00 · até 5 km R$ 8,00 · até 8 km R$ 12,00 (além disso não entrega)
-- A distância é em linha reta entre a loja e o endereço (aproximada).
-- ---------------------------------------------------------------------
create function public.valid_tiers(t jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(t) = 'array' and jsonb_array_length(t) between 1 and 10 and not exists (
    select 1 from jsonb_array_elements(t) r
    where jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 2
       or jsonb_typeof(r->0) <> 'number' or jsonb_typeof(r->1) <> 'number'
       or (r->>0)::numeric <= 0 or (r->>0)::numeric > 100 or (r->>1)::numeric < 0 or (r->>1)::numeric > 100000
       or (r->>1)::numeric <> trunc((r->>1)::numeric))
$$;

alter table public.tenants
  add column delivery_mode text not null default 'zones' check (delivery_mode in ('zones', 'distance')),
  add column lat double precision check (lat between -90 and 90),
  add column lng double precision check (lng between -180 and 180),
  add column distance_tiers jsonb not null default '[[2, 500], [5, 800], [8, 1200]]'::jsonb check (public.valid_tiers(distance_tiers)),
  add column loyalty_enabled boolean not null default false,
  add column loyalty_every integer not null default 10 check (loyalty_every between 2 and 50),
  add column loyalty_percent integer not null default 10 check (loyalty_percent between 1 and 50);
alter table public.tenants add constraint tenants_distance_location check (delivery_mode <> 'distance' or (lat is not null and lng is not null));

alter table public.orders
  add column delivery_km numeric(6, 1),
  add column dest_lat double precision,
  add column dest_lng double precision,
  add column loyalty_discount integer not null default 0;

grant update (delivery_mode, lat, lng, distance_tiers, loyalty_enabled, loyalty_every, loyalty_percent) on public.tenants to authenticated;

create function public.haversine_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) returns double precision
language sql immutable as $$
  select 2 * 6371 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- taxa da primeira faixa que cobre a distância; null = fora da área
create function public.distance_fee(p_tiers jsonb, p_km numeric) returns integer
language sql immutable as $$
  select (r->>1)::int from jsonb_array_elements(p_tiers) r where p_km <= (r->>0)::numeric order by (r->>0)::numeric limit 1
$$;

-- Cotação pública (mostrada no checkout antes de enviar o pedido)
create function public.delivery_quote(p_slug text, p_lat double precision, p_lng double precision) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t tenants; v_km numeric; v_fee int;
begin
  select * into t from tenants where slug = p_slug and active;
  if not found or t.delivery_mode <> 'distance' or t.lat is null then return null; end if;
  v_km := round(haversine_km(t.lat, t.lng, p_lat, p_lng)::numeric, 1);
  v_fee := distance_fee(t.distance_tiers, v_km);
  return jsonb_build_object('km', v_km, 'fee', v_fee, 'inArea', v_fee is not null,
    'maxKm', (select max((r->>0)::numeric) from jsonb_array_elements(t.distance_tiers) r));
end $$;

-- ---------------------------------------------------------------------
-- Fidelidade: selos = pedidos entregues desde o último resgate (identifica o cliente pelo telefone)
-- ---------------------------------------------------------------------
create function public.loyalty_stamps(p_tenant uuid, p_phone text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(0,
    (select count(*) from orders where tenant_id = p_tenant and status = 'entregue' and phone_key(customer_phone) = phone_key(p_phone))
    - (select count(*) from orders where tenant_id = p_tenant and loyalty_discount > 0 and status <> 'cancelado' and phone_key(customer_phone) = phone_key(p_phone))
      * (select loyalty_every from tenants where id = p_tenant))::int
$$;

create or replace function public._create_order(t public.tenants, p jsonb, p_check_min boolean default true, p_status text default 'novo') returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p->'customer'->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p->'customer'->>'phone', '')), 30);
  v_ful text := case when p->>'fulfillment' = 'pickup' then 'pickup' else 'delivery' end;
  v_pay text := p->>'payment';
  v_fee int := 0; v_zone text := ''; v_addr text := '';
  z zones; c coupons; pr products; g option_groups; v_km numeric; v_lat double precision; v_lng double precision;
  v_coupon text; v_loy int := 0; v_every int; v_avail int;
  it jsonb; v_items jsonb := '[]'; v_qty int; v_unit int; v_labels text[]; v_chosen bigint[]; v_cnt int; v_add int;
  v_sub int := 0; v_disc int := 0; v_total int; v_change int; v_num int; o orders;
begin
  if v_name = '' or length(regexp_replace(v_phone, '\D', '', 'g')) < 8 then raise exception 'Informe nome e telefone válidos'; end if;
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
  if v_pay is null or v_pay not in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online') then raise exception 'Forma de pagamento inválida'; end if;
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

  if p_check_min and v_sub < t.min_order then raise exception 'Pedido abaixo do valor mínimo da loja'; end if;
  if coalesce(trim(p->>'coupon'), '') <> '' then
    select * into c from coupons where tenant_id = t.id and code = upper(trim(p->>'coupon')) and active;
    if not found then raise exception 'Cupom inválido'; end if;
    v_disc := round(v_sub * c.percent / 100.0);
    if c.free_shipping then v_fee := 0; end if;
    v_coupon := c.code;
  end if;
  -- fidelidade: a cada N pedidos entregues, desconto no próximo (não soma com cupom: vale o maior)
  if t.loyalty_enabled then
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
                      subtotal, fee, discount, total, coupon_code, status, payment_status, delivery_km, dest_lat, dest_lng, loyalty_discount)
  values (t.id, v_num, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_name, v_phone, v_ful, v_addr, v_zone, v_pay, v_change,
          v_sub, v_fee, v_disc, v_total, v_coupon, p_status, case when v_pay = 'Pix online' then 'pending' else 'na' end, v_km, v_lat, v_lng, v_loy)
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
      'paymentStatus', o.payment_status, 'loyaltyDiscount', o.loyalty_discount, 'km', o.delivery_km,
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

create or replace function public.store_customers(p_tenant uuid, p_search text default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb; v_every int; v_s text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select loyalty_every into v_every from tenants where id = p_tenant;
  with c as (
    select phone_key(customer_phone) k,
      (array_agg(customer_name order by created_at desc))[1] name,
      (array_agg(customer_phone order by created_at desc))[1] phone,
      (array_agg(address order by created_at desc) filter (where address <> ''))[1] address,
      count(*) filter (where status not in ('cancelado', 'pagamento')) orders,
      coalesce(sum(total) filter (where status not in ('cancelado', 'pagamento')), 0) spent,
      max(created_at) last_order, min(created_at) first_order
    from orders where tenant_id = p_tenant and customer_phone <> 'removido'
    group by phone_key(customer_phone))
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'name', name, 'phone', phone, 'address', address, 'orders', orders,
      'spent', spent, 'lastOrder', last_order, 'firstOrder', first_order, 'stamps', loyalty_stamps(p_tenant, phone)) order by last_order desc), '[]') into r
  from (select * from c
        where v_s is null or name ilike '%' || v_s || '%' or k like '%' || regexp_replace(v_s, '\D', '', 'g') || '%' and regexp_replace(v_s, '\D', '', 'g') <> ''
        order by last_order desc limit least(greatest(p_limit, 1), 1000)) x;
  return r;
end $$;

revoke execute on function public.loyalty_stamps(uuid, text), public.haversine_km(double precision, double precision, double precision, double precision),
  public.distance_fee(jsonb, numeric) from public, anon;
grant execute on function public.valid_tiers(jsonb) to authenticated;
grant execute on function public.delivery_quote(text, double precision, double precision) to anon, authenticated;
