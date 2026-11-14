-- =====================================================================
-- Balcão — Pix online pelo Mercado Pago
-- Cada loja liga a própria conta do Mercado Pago e recebe direto nela.
-- O pedido fica em "pagamento" até o Mercado Pago confirmar; só então aparece no preparo.
-- Rode depois de 20261114000000_horarios_fotos.sql
-- =====================================================================

alter table public.tenants add column pix_online boolean not null default false;

-- Token da conta do Mercado Pago de cada loja. Ninguém lê pelo site: só as funções do servidor.
create table public.tenant_pix (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  mp_access_token text not null,
  updated_at timestamptz not null default now()
);
alter table public.tenant_pix enable row level security;
revoke all on public.tenant_pix from anon, authenticated;

alter table public.orders drop constraint orders_payment_check;
alter table public.orders add constraint orders_payment_check check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online'));
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('pagamento', 'novo', 'preparo', 'pronto', 'rota', 'entregue', 'cancelado'));
alter table public.orders
  add column payment_status text not null default 'na' check (payment_status in ('na', 'pending', 'paid', 'expired')),
  add column paid_at timestamptz,
  add column pix_ref text,
  add column pix_qr text,
  add column pix_qr_base64 text,
  add column pix_expires_at timestamptz;

-- Pedidos agora podem nascer com outro status (ex.: aguardando pagamento)
drop function public._create_order(public.tenants, jsonb, boolean);

create function public._create_order(t public.tenants, p jsonb, p_check_min boolean default true, p_status text default 'novo') returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p->'customer'->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p->'customer'->>'phone', '')), 30);
  v_ful text := case when p->>'fulfillment' = 'pickup' then 'pickup' else 'delivery' end;
  v_pay text := p->>'payment';
  v_fee int := 0; v_zone text := ''; v_addr text := '';
  z zones; c coupons; pr products; g option_groups;
  it jsonb; v_items jsonb := '[]'; v_qty int; v_unit int; v_labels text[]; v_chosen bigint[]; v_cnt int; v_add int;
  v_sub int := 0; v_disc int := 0; v_total int; v_change int; v_num int; o orders;
begin
  if v_name = '' or length(regexp_replace(v_phone, '\D', '', 'g')) < 8 then raise exception 'Informe nome e telefone válidos'; end if;
  if v_ful = 'pickup' and not t.allow_pickup then raise exception 'Esta loja não aceita retirada'; end if;
  if v_ful = 'delivery' then
    select * into z from zones where tenant_id = t.id and id::text = coalesce(p->>'zoneId', '');
    if not found then raise exception 'Escolha um bairro atendido'; end if;
    v_addr := left(trim(coalesce(p->>'address', '')), 200);
    if length(v_addr) < 5 then raise exception 'Informe o endereço de entrega'; end if;
    v_fee := z.fee; v_zone := z.name;
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
  end if;
  v_total := v_sub + v_fee - v_disc;
  if v_pay = 'Dinheiro' and coalesce(p->>'changeFor', '') ~ '^\d{1,8}$' and (p->>'changeFor')::int > v_total then
    v_change := (p->>'changeFor')::int;
  end if;

  perform pg_advisory_xact_lock(hashtext(t.id::text));
  select coalesce(max(number), 100) + 1 into v_num from orders where tenant_id = t.id;
  insert into orders (tenant_id, number, public_code, customer_name, customer_phone, fulfillment, address, zone_name, payment, change_for,
                      subtotal, fee, discount, total, coupon_code, status, payment_status)
  values (t.id, v_num, upper(left(replace(gen_random_uuid()::text, '-', ''), 12)), v_name, v_phone, v_ful, v_addr, v_zone, v_pay, v_change,
          v_sub, v_fee, v_disc, v_total, c.code, p_status, case when v_pay = 'Pix online' then 'pending' else 'na' end)
  returning * into o;
  insert into order_items (order_id, tenant_id, product_id, product_name, options_text, qty, unit_price, notes)
    select o.id, t.id, (x->>'product_id')::bigint, x->>'product_name', x->>'options_text', (x->>'qty')::int, (x->>'unit_price')::int, x->>'notes'
    from jsonb_array_elements(v_items) x;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $$;

create or replace function public.change_order_status(p_order bigint, p_status text, p_courier bigint default null) returns public.orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; v_allowed text[];
begin
  select * into o from orders where id = p_order for update;
  if not found or not is_member(o.tenant_id) then raise exception 'Pedido não encontrado'; end if;
  v_allowed := case o.status
    when 'pagamento' then array['cancelado']
    when 'novo' then array['preparo', 'cancelado']
    when 'preparo' then array['pronto', 'cancelado']
    when 'pronto' then array['rota', 'entregue', 'cancelado']
    when 'rota' then array['entregue']
    else '{}'::text[] end;
  if not p_status = any(v_allowed) then raise exception 'Não é possível ir de "%" para "%"', o.status, p_status; end if;
  if p_status = 'rota' then
    if o.fulfillment <> 'delivery' then raise exception 'Pedido de retirada não sai para entrega'; end if;
    if not exists (select 1 from couriers where id = p_courier and tenant_id = o.tenant_id and active) then
      raise exception 'Escolha um entregador ativo';
    end if;
  end if;
  if p_status = 'entregue' and o.status = 'pronto' and o.fulfillment = 'delivery' then
    raise exception 'Despache o pedido antes de confirmar a entrega';
  end if;
  update orders set status = p_status, updated_at = now(),
    courier_id = case when p_status = 'rota' then p_courier else courier_id end
  where id = p_order returning * into o;
  insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, p_status);
  return o;
end $$;

create or replace function public.store_report(p_tenant uuid, p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_from timestamptz; v_tz text; r jsonb;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select timezone into v_tz from tenants where id = p_tenant;
  v_from := case when p_days <= 1 then date_trunc('day', now() at time zone v_tz) at time zone v_tz
                 else now() - make_interval(days => least(greatest(p_days, 1), 366)) end;
  with o as (select * from orders where tenant_id = p_tenant and created_at >= v_from and status <> 'pagamento' and not (status = 'cancelado' and payment_status = 'expired')),
       ok as (select * from o where status <> 'cancelado')
  select jsonb_build_object(
    'days', p_days,
    'orders', (select count(*) from ok),
    'revenue', (select coalesce(sum(total), 0) from ok),
    'avgTicket', (select coalesce(round(avg(total)), 0) from ok),
    'cancelled', (select count(*) from o where status = 'cancelado'),
    'avgDeliveryMin', (select round(extract(epoch from avg(e.at - ok.created_at)) / 60) from ok join order_events e on e.order_id = ok.id and e.status = 'entregue'),
    'byHour', (select coalesce(jsonb_agg(x order by x->>'h'), '[]') from (select jsonb_build_object('h', extract(hour from created_at at time zone v_tz)::int,
                 'orders', count(*), 'revenue', sum(total)) x from ok group by extract(hour from created_at at time zone v_tz)) s),
    'byDay', (select coalesce(jsonb_agg(x order by x->>'d'), '[]') from (select jsonb_build_object('d', to_char(created_at at time zone v_tz, 'YYYY-MM-DD'),
                 'orders', count(*), 'revenue', sum(total)) x from ok group by to_char(created_at at time zone v_tz, 'YYYY-MM-DD')) s),
    'top', (select coalesce(jsonb_agg(x order by (x->>'qty')::int desc), '[]') from (select jsonb_build_object('name', i.product_name, 'qty', sum(i.qty),
                 'revenue', sum(i.qty * i.unit_price)) x from order_items i join ok on ok.id = i.order_id group by i.product_name order by sum(i.qty) desc limit 8) s),
    'payments', (select coalesce(jsonb_agg(x order by (x->>'revenue')::int desc), '[]') from (select jsonb_build_object('payment', payment, 'orders', count(*),
                 'revenue', sum(total)) x from ok group by payment) s),
    'couriers', (select coalesce(jsonb_agg(x order by (x->>'deliveries')::int desc), '[]') from (select jsonb_build_object('name', c.name,
                 'deliveries', count(ok.id), 'fees', coalesce(sum(ok.fee), 0)) x from couriers c left join ok on ok.courier_id = c.id and ok.status = 'entregue'
                 where c.tenant_id = p_tenant group by c.id, c.name) s)
  ) into r;
  return r;
end $$;

create or replace function public.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  with t as (
    select t.*, s.name segment_name,
      (select count(*) from orders o where o.tenant_id = t.id) n_orders,
      (select coalesce(sum(total), 0) from orders o where o.tenant_id = t.id and o.status not in ('cancelado', 'pagamento')) revenue,
      (select u.email from memberships m join auth.users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1) owner_email
    from tenants t join segment_templates s on s.segment = t.segment)
  select jsonb_build_object(
    'mrr', (select coalesce(sum(p.price), 0) from t join plans p on p.name = t.plan where t.active),
    'gmv', (select coalesce(sum(revenue), 0) from t),
    'orders', (select coalesce(sum(n_orders), 0) from t),
    'tenants', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'name', name, 'segment', segment, 'segmentName', segment_name,
                 'color', color, 'plan', plan, 'active', active, 'orders', n_orders, 'revenue', revenue, 'ownerEmail', owner_email, 'createdAt', created_at)
                 order by created_at), '[]') from t)) into r;
  return r;
end $$;

create or replace function public.place_order(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; v_limit int; o orders;
begin
  select * into t from tenants where slug = p_slug and active;
  if not found then raise exception 'Loja não encontrada'; end if;
  if not store_open_at(t) then raise exception 'A loja está fechada no momento'; end if;
  select monthly_orders into v_limit from plans where name = t.plan;
  if v_limit is not null and (select count(*) from orders where tenant_id = t.id and status <> 'pagamento'
      and created_at >= (date_trunc('month', now() at time zone t.timezone) at time zone t.timezone)) >= v_limit then
    raise exception 'A loja atingiu o limite de pedidos do plano neste mês';
  end if;
  o := _create_order(t, p, true, case when p->>'payment' = 'Pix online' then 'pagamento' else 'novo' end);
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'pix', o.payment = 'Pix online');
end $$;

create or replace function public.track_order(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'store', jsonb_build_object('slug', t.slug, 'name', t.name, 'color', t.color, 'phone', t.phone),
    'order', jsonb_build_object('number', o.number, 'status', o.status, 'fulfillment', o.fulfillment,
      'customerName', split_part(o.customer_name, ' ', 1), 'address', o.address, 'zone', o.zone_name, 'payment', o.payment,
      'paymentStatus', o.payment_status,
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

-- ---------------------------------------------------------------------
-- Configuração do Pix pelo dono da loja
-- ---------------------------------------------------------------------
create function public.set_pix_settings(p_tenant uuid, p_token text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if nullif(trim(p_token), '') is not null then
    if trim(p_token) !~ '^(APP_USR|TEST)-[A-Za-z0-9_-]{20,}$' then raise exception 'Access Token inválido: ele começa com APP_USR- (produção) ou TEST- (teste)'; end if;
    insert into tenant_pix (tenant_id, mp_access_token) values (p_tenant, trim(p_token))
      on conflict (tenant_id) do update set mp_access_token = excluded.mp_access_token, updated_at = now();
  end if;
  if p_enabled and not exists (select 1 from tenant_pix where tenant_id = p_tenant) then
    raise exception 'Cadastre o Access Token do Mercado Pago antes de ativar';
  end if;
  update tenants set pix_online = p_enabled where id = p_tenant;
  return pix_settings(p_tenant);
end $$;

create function public.pix_settings(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_tok text;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select mp_access_token into v_tok from tenant_pix where tenant_id = p_tenant;
  return jsonb_build_object('configured', v_tok is not null, 'enabled', (select pix_online from tenants where id = p_tenant),
    'test', v_tok like 'TEST-%', 'hint', case when v_tok is not null then '…' || right(v_tok, 4) end);
end $$;

-- ---------------------------------------------------------------------
-- Funções usadas só pela Edge Function "pix" (chave de serviço)
-- ---------------------------------------------------------------------
create function public.pix_order(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', o.id, 'number', o.number, 'code', o.public_code, 'total', o.total, 'status', o.status,
    'payment', o.payment, 'paymentStatus', o.payment_status, 'pixRef', o.pix_ref, 'pixQr', o.pix_qr, 'pixQrBase64', o.pix_qr_base64,
    'pixExpiresAt', o.pix_expires_at, 'customerName', o.customer_name, 'tenantId', t.id, 'storeName', t.name, 'pixOnline', t.pix_online,
    'token', tp.mp_access_token)
  from orders o join tenants t on t.id = o.tenant_id left join tenant_pix tp on tp.tenant_id = t.id
  where o.public_code = upper(trim(p_code))
$$;

create function public.pix_token(p_tenant uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select mp_access_token from tenant_pix where tenant_id = p_tenant
$$;

create function public.pix_save(p_order bigint, p_ref text, p_qr text, p_qr_base64 text, p_expires timestamptz) returns void
language sql security definer set search_path = public, pg_temp as $$
  update orders set pix_ref = p_ref, pix_qr = p_qr, pix_qr_base64 = p_qr_base64, pix_expires_at = p_expires
  where id = p_order and status = 'pagamento'
$$;

-- Aplica o resultado conferido na API do Mercado Pago. Idempotente: pode ser chamada várias vezes.
create function public.pix_apply(p_tenant uuid, p_order bigint, p_ref text, p_mp_status text, p_amount integer) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  select * into o from orders where id = p_order and tenant_id = p_tenant for update;
  if not found or o.payment <> 'Pix online' then raise exception 'Pedido não encontrado'; end if;
  if o.pix_ref is not null and o.pix_ref <> p_ref then raise exception 'Pagamento não corresponde ao pedido'; end if;
  if p_mp_status = 'approved' then
    if p_amount <> o.total then raise exception 'Valor pago (%) diferente do total (%)', p_amount, o.total; end if;
    if o.payment_status = 'paid' then return o.status; end if;
    if o.status = 'pagamento' or (o.status = 'cancelado' and o.payment_status = 'expired') then
      -- pago (mesmo que depois do prazo): o pedido vai para o preparo
      update orders set payment_status = 'paid', paid_at = now(), pix_ref = p_ref, status = 'novo', updated_at = now()
      where id = o.id returning * into o;
      insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'novo');
    else
      -- a loja cancelou o pedido antes do pagamento cair: fica registrado como pago para a loja devolver o valor
      update orders set payment_status = 'paid', paid_at = now(), pix_ref = p_ref, updated_at = now() where id = o.id returning * into o;
    end if;
    return o.status;
  elsif p_mp_status in ('cancelled', 'rejected', 'expired') and o.status = 'pagamento' then
    update orders set status = 'cancelado', payment_status = 'expired', updated_at = now() where id = o.id returning * into o;
    insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'cancelado');
  end if;
  return o.status;
end $$;

-- Cancela pedidos de Pix não pagos depois do prazo (a função "pix" chama de vez em quando; dá para agendar com pg_cron)
create function public.pix_expire_overdue() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with x as (
    update orders set status = 'cancelado', payment_status = 'expired', updated_at = now()
    where status = 'pagamento' and created_at < now() - interval '45 minutes'
    returning id, tenant_id)
  insert into order_events (order_id, tenant_id, status) select id, tenant_id, 'cancelado' from x;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public._create_order(public.tenants, jsonb, boolean, text) from public, anon, authenticated;
revoke execute on function public.pix_order(text), public.pix_token(uuid), public.pix_save(bigint, text, text, text, timestamptz),
  public.pix_apply(uuid, bigint, text, text, integer), public.pix_expire_overdue() from public, anon, authenticated;
grant execute on function public.pix_order(text), public.pix_token(uuid), public.pix_save(bigint, text, text, text, timestamptz),
  public.pix_apply(uuid, bigint, text, text, integer), public.pix_expire_overdue() to service_role;
revoke execute on function public.set_pix_settings(uuid, text, boolean), public.pix_settings(uuid) from public, anon;
grant execute on function public.set_pix_settings(uuid, text, boolean), public.pix_settings(uuid) to authenticated;
