-- =====================================================================
-- Balcão — cupons completos, avaliações dos pedidos e controle de estoque
-- Rode depois de 20261119000000_balcao_mesa_caixa.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Cupons: valor mínimo, validade, limite total, limite por cliente e só na 1ª compra
-- ---------------------------------------------------------------------
alter table public.coupons
  add column min_subtotal integer not null default 0 check (min_subtotal >= 0),
  add column valid_until timestamptz,
  add column max_uses integer check (max_uses > 0),
  add column max_per_customer integer check (max_per_customer > 0),
  add column first_order_only boolean not null default false;
grant update (min_subtotal, valid_until, max_uses, max_per_customer, first_order_only) on public.coupons to authenticated;

create or replace function public.check_coupon(p_slug text, p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('code', c.code, 'percent', c.percent, 'freeShipping', c.free_shipping, 'minSubtotal', c.min_subtotal,
    'validUntil', c.valid_until, 'firstOrderOnly', c.first_order_only,
    'soldOut', c.max_uses is not null and (select count(*) from orders o where o.tenant_id = t.id and o.coupon_code = c.code and o.status <> 'cancelado') >= c.max_uses)
  from coupons c join tenants t on t.id = c.tenant_id
  where t.slug = p_slug and t.active and c.active and c.code = upper(trim(p_code)) and (c.valid_until is null or c.valid_until >= now())
$$;

create function public.coupon_usage(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  return (select coalesce(jsonb_object_agg(code, n), '{}') from (select coupon_code code, count(*) n from orders
          where tenant_id = p_tenant and coupon_code is not null and status <> 'cancelado' group by coupon_code) x);
end $$;

-- ---------------------------------------------------------------------
-- Estoque: null = sem controle; número = unidades disponíveis
-- ---------------------------------------------------------------------
alter table public.products add column stock integer check (stock >= 0);

create function public.set_stock(p_product bigint, p_stock integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from products where id = p_product;
  if v_tenant is null or not is_member(v_tenant) then raise exception 'Sem permissão'; end if;
  if p_stock is not null and (p_stock < 0 or p_stock > 1000000) then raise exception 'Estoque inválido'; end if;
  update products set stock = p_stock where id = p_product;
end $$;

-- Devolve o estoque quando o pedido é cancelado (e baixa de novo se um pedido cancelado voltar, ex.: Pix pago depois do prazo)
create function public._stock_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sign int;
begin
  if new.status = old.status then return new; end if;
  if new.status = 'cancelado' then v_sign := 1;
  elsif old.status = 'cancelado' then v_sign := -1;
  else return new; end if;
  update products p set stock = greatest(0, p.stock + v_sign * x.q)
  from (select product_id, sum(qty) q from order_items where order_id = new.id group by product_id) x
  where p.id = x.product_id and p.stock is not null;
  return new;
end $$;
create trigger orders_stock_on_status after update of status on public.orders for each row execute function public._stock_on_status();

-- ---------------------------------------------------------------------
-- Avaliações: o cliente avalia o pedido entregue (até 7 dias); a loja pode responder
-- ---------------------------------------------------------------------
create table public.order_reviews (
  order_id bigint primary key references public.orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text not null default '' check (length(comment) <= 500),
  reply text check (length(reply) <= 500),
  created_at timestamptz not null default now(),
  replied_at timestamptz
);
create index on public.order_reviews (tenant_id, created_at desc);
alter table public.order_reviews enable row level security;
revoke all on public.order_reviews from anon, authenticated;
grant select on public.order_reviews to authenticated;
create policy "equipe vê avaliações" on public.order_reviews for select using (is_member(tenant_id));

create function public.review_order(p_code text, p_rating integer, p_comment text default '') returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  select * into o from orders where public_code = upper(trim(p_code));
  if not found then raise exception 'Pedido não encontrado'; end if;
  if o.status <> 'entregue' then raise exception 'Você pode avaliar depois que o pedido for entregue'; end if;
  if o.updated_at < now() - interval '7 days' then raise exception 'O prazo para avaliar este pedido terminou'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'Escolha de 1 a 5 estrelas'; end if;
  insert into order_reviews (order_id, tenant_id, rating, comment) values (o.id, o.tenant_id, p_rating, left(trim(coalesce(p_comment, '')), 500));
exception when unique_violation then raise exception 'Este pedido já foi avaliado';
end $$;

create function public.reply_review(p_order bigint, p_reply text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from order_reviews where order_id = p_order;
  if v_tenant is null or not is_owner(v_tenant) then raise exception 'Sem permissão'; end if;
  update order_reviews set reply = nullif(left(trim(coalesce(p_reply, '')), 500), ''), replied_at = now() where order_id = p_order;
end $$;

-- Nota pública da loja e avaliações recentes (sem dados pessoais além do primeiro nome)
create function public.store_reviews(p_slug text, p_limit integer default 10) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'avg', (select round(avg(r.rating)::numeric, 1) from order_reviews r where r.tenant_id = t.id),
    'count', (select count(*) from order_reviews r where r.tenant_id = t.id),
    'recent', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]') from (
        select jsonb_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply, 'at', r.created_at,
          'name', case when o.customer_phone = 'removido' then 'Cliente' else split_part(o.customer_name, ' ', 1) end) x
        from order_reviews r join orders o on o.id = r.order_id
        where r.tenant_id = t.id and r.comment <> '' order by r.created_at desc limit least(greatest(p_limit, 1), 50)) s))
  from tenants t where t.slug = p_slug and t.active
$$;

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
  v_coupon text; v_loy int := 0; v_every int; v_avail int; v_left int; v_pk text;
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

create or replace function public.track_order(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'store', jsonb_build_object('slug', t.slug, 'name', t.name, 'color', t.color, 'phone', t.phone),
    'order', jsonb_build_object('number', o.number, 'status', o.status, 'fulfillment', o.fulfillment,
      'customerName', split_part(o.customer_name, ' ', 1), 'address', o.address, 'zone', o.zone_name, 'payment', o.payment,
      'paymentStatus', o.payment_status,
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

revoke execute on function public._stock_on_status() from public, anon, authenticated;
revoke execute on function public.coupon_usage(uuid), public.set_stock(bigint, integer), public.reply_review(bigint, text) from public, anon;
grant execute on function public.coupon_usage(uuid), public.set_stock(bigint, integer), public.reply_review(bigint, text) to authenticated;
grant execute on function public.review_order(text, integer, text), public.store_reviews(text, integer) to anon, authenticated;
