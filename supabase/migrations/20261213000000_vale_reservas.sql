-- =====================================================================
-- Balcão — vale-presente e reserva de mesas
-- Rode depois de 20261212000000_acerto_entregadores.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. VALE-PRESENTE ------------------------------------------------------
create table if not exists public.gift_cards (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null check (code ~ '^VP[A-Z2-9]{8}$'),
  initial integer not null check (initial between 100 and 1000000),
  balance integer not null check (balance >= 0),
  buyer_name text check (char_length(buyer_name) <= 80),
  recipient_name text check (char_length(recipient_name) <= 80),
  message text check (char_length(message) <= 200),
  sold_method text not null check (sold_method in ('Dinheiro', 'Pix', 'Cartão', 'Cortesia')),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  unique (tenant_id, code)
);
create table if not exists public.gift_card_moves (
  id bigint generated always as identity primary key,
  card_id bigint not null references public.gift_cards(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id bigint references public.orders(id) on delete set null,
  amount integer not null,
  kind text not null check (kind in ('venda', 'uso', 'estorno', 'cancelado')),
  at timestamptz not null default now(),
  by_user uuid
);
create index if not exists gift_card_moves_card on public.gift_card_moves (card_id);
alter table public.gift_cards enable row level security;
alter table public.gift_card_moves enable row level security;
drop policy if exists "equipe vê vales" on public.gift_cards;
create policy "equipe vê vales" on public.gift_cards for select using (is_member(tenant_id));
drop policy if exists "equipe vê movimentos dos vales" on public.gift_card_moves;
create policy "equipe vê movimentos dos vales" on public.gift_card_moves for select using (is_member(tenant_id));
revoke all on public.gift_cards, public.gift_card_moves from anon, authenticated;
grant select on public.gift_cards, public.gift_card_moves to authenticated;

alter table public.orders add column if not exists gift_used integer not null default 0;
alter table public.orders add column if not exists gift_card_id bigint references public.gift_cards(id) on delete set null;
alter table public.orders drop constraint if exists orders_payment_check;
alter table public.orders add constraint orders_payment_check
  check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa', 'Dividido', 'Vale-presente'));

-- Equipe vende o vale (depois de receber o pagamento)
create or replace function public.gift_card_create(p_tenant uuid, p_amount integer, p_buyer text, p_recipient text, p_message text, p_method text, p_days integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_code text; g gift_cards; i int := 0;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if p_amount is null or p_amount not between 100 and 1000000 then raise exception 'Valor do vale: de R$ 1,00 a R$ 10.000,00'; end if;
  if p_method not in ('Dinheiro', 'Pix', 'Cartão', 'Cortesia') then raise exception 'Forma de pagamento inválida'; end if;
  if p_method = 'Cortesia' and not is_owner(p_tenant) then raise exception 'Só o dono pode dar vale de cortesia'; end if;
  loop
    i := i + 1; if i > 20 then raise exception 'Tente de novo'; end if;
    v_code := 'VP' || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 8));
    begin
      insert into gift_cards (tenant_id, code, initial, balance, buyer_name, recipient_name, message, sold_method, expires_at, created_by)
        values (p_tenant, v_code, p_amount, p_amount, nullif(left(trim(coalesce(p_buyer, '')), 80), ''), nullif(left(trim(coalesce(p_recipient, '')), 80), ''),
                nullif(left(trim(coalesce(p_message, '')), 200), ''), p_method,
                case when coalesce(p_days, 365) > 0 then now() + make_interval(days => least(coalesce(p_days, 365), 1095)) end, auth.uid())
        returning * into g;
      exit;
    exception when unique_violation then null;
    end;
  end loop;
  insert into gift_card_moves (card_id, tenant_id, amount, kind, by_user) values (g.id, p_tenant, p_amount, 'venda', auth.uid());
  perform _log(p_tenant, 'Vale-presente vendido', _money(p_amount) || ' · ' || p_method || coalesce(' · para ' || g.recipient_name, ''));
  return jsonb_build_object('id', g.id, 'code', g.code, 'amount', g.initial, 'expires', g.expires_at);
end $$;
revoke execute on function public.gift_card_create(uuid, integer, text, text, text, text, integer) from public, anon;
grant execute on function public.gift_card_create(uuid, integer, text, text, text, text, integer) to authenticated;

-- Dono cancela um vale (zera o saldo)
create or replace function public.gift_card_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare g gift_cards;
begin
  select * into g from gift_cards where id = p_id for update;
  if g.id is null or not is_owner(g.tenant_id) then raise exception 'Sem permissão'; end if;
  if not g.active then return; end if;
  update gift_cards set active = false, balance = 0 where id = g.id;
  insert into gift_card_moves (card_id, tenant_id, amount, kind, by_user) values (g.id, g.tenant_id, -g.balance, 'cancelado', auth.uid());
  perform _log(g.tenant_id, 'Vale-presente cancelado', g.code || ' · saldo ' || _money(g.balance));
end $$;
revoke execute on function public.gift_card_cancel(bigint) from public, anon;
grant execute on function public.gift_card_cancel(bigint) to authenticated;

-- Cliente confere o saldo na loja online (limitado, contra tentativa de adivinhar códigos)
create or replace function public.gift_card_check(p_slug text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare g gift_cards;
begin
  perform _rate_limit('gift:' || coalesce(_client_ip(), '-'), 15, interval '10 minutes', 'Muitas tentativas. Aguarde alguns minutos.');
  select gc.* into g from gift_cards gc join tenants t on t.id = gc.tenant_id
    where t.slug = p_slug and gc.code = regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g');
  if g.id is null or not g.active or g.balance <= 0 or (g.expires_at is not null and g.expires_at < now()) then return null; end if;
  return jsonb_build_object('code', g.code, 'balance', g.balance, 'expires', g.expires_at);
end $$;
revoke execute on function public.gift_card_check(text, text) from public;
grant execute on function public.gift_card_check(text, text) to anon, authenticated;

-- Pedido cancelado devolve o saldo usado
create or replace function public._gift_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'cancelado' and old.status <> 'cancelado' and new.gift_used > 0 and new.gift_card_id is not null
     and not exists (select 1 from gift_card_moves where order_id = new.id and kind = 'estorno') then
    update gift_cards set balance = balance + new.gift_used where id = new.gift_card_id and active;
    insert into gift_card_moves (card_id, tenant_id, order_id, amount, kind) values (new.gift_card_id, new.tenant_id, new.id, new.gift_used, 'estorno');
  end if;
  return new;
end $$;
revoke execute on function public._gift_on_status() from public, anon, authenticated;
drop trigger if exists orders_gift_on_status on public.orders;
create trigger orders_gift_on_status after update of status on public.orders for each row execute function public._gift_on_status();

-- Criação de pedidos aceita o vale ("giftCode")
CREATE OR REPLACE FUNCTION public._create_order(t tenants, p jsonb, p_check_min boolean DEFAULT true, p_status text DEFAULT 'novo'::text, p_channel text DEFAULT 'online'::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_sub int := 0; v_disc int := 0; v_service int := 0; v_total int; v_change int; v_num int; o orders; v_gift int := 0; gc gift_cards;
begin
  -- Uma venda por vez em cada loja: limites de cupom, fidelidade e numeração ficam corretos mesmo com muitos pedidos ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext(t.id::text));
  if p_channel not in ('online', 'balcao', 'telefone', 'mesa', 'totem') then raise exception 'Canal inválido'; end if;
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
  -- vale-presente: desconta do total (inclui entrega e serviço); se cobrir tudo, o pagamento vira "Vale-presente"
  if coalesce(p->>'giftCode', '') <> '' then
    select * into gc from gift_cards where tenant_id = t.id and code = regexp_replace(upper(p->>'giftCode'), '[^A-Z0-9]', '', 'g') for update;
    if gc.id is null or not gc.active or gc.balance <= 0 or (gc.expires_at is not null and gc.expires_at < now()) then raise exception 'Vale-presente inválido, vencido ou sem saldo'; end if;
    v_gift := least(gc.balance, v_total);
    v_total := v_total - v_gift;
    if v_total = 0 then v_pay := 'Vale-presente'; if p_status = 'pagamento' then p_status := 'novo'; end if; end if;
  end if;
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
  if v_gift > 0 then
    update orders set gift_used = v_gift, gift_card_id = gc.id where id = o.id returning * into o;
    update gift_cards set balance = balance - v_gift where id = gc.id;
    insert into gift_card_moves (card_id, tenant_id, order_id, amount, kind) values (gc.id, t.id, o.id, -v_gift, 'uso');
  end if;
  if v_cb > 0 then
    update orders set cashback_used = v_cb where id = o.id returning * into o;
    insert into cashback_ledger (tenant_id, phone_key, order_id, amount, kind) values (t.id, phone_key(v_phone), o.id, -v_cb, 'uso');
  end if;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $function$;

-- Caixa: vale vendido em dinheiro entra na gaveta
CREATE OR REPLACE FUNCTION public.cash_status(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s cash_sessions; v_cash int; v_in int; v_out int; v_last jsonb;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into s from cash_sessions where tenant_id = p_tenant and closed_at is null;
  select to_jsonb(x) into v_last from (select id, opened_at, closed_at, opening_amount, counted_amount, expected_amount, counted_amount - expected_amount diff, note
    from cash_sessions where tenant_id = p_tenant and closed_at is not null order by closed_at desc limit 1) x;
  if s.id is null then return jsonb_build_object('open', false, 'last', v_last); end if;
  select coalesce(sum(total), 0) into v_cash from orders
    where tenant_id = p_tenant and payment = 'Dinheiro' and status not in ('cancelado', 'pagamento') and created_at >= s.opened_at
  ;
  -- contas de mesa divididas: a parte paga em dinheiro também entra na gaveta
  v_cash := v_cash + coalesce((select sum(amount) from table_payments where tenant_id = p_tenant and method = 'Dinheiro' and at >= s.opened_at), 0);
  -- vale-presente vendido em dinheiro entra na gaveta
  v_cash := v_cash + coalesce((select sum(initial) from gift_cards where tenant_id = p_tenant and sold_method = 'Dinheiro' and created_at >= s.opened_at), 0);
  select coalesce(sum(amount) filter (where kind = 'suprimento'), 0), coalesce(sum(amount) filter (where kind = 'sangria'), 0) into v_in, v_out
    from cash_moves where session_id = s.id;
  return jsonb_build_object('open', true, 'id', s.id, 'openedAt', s.opened_at, 'opening', s.opening_amount,
    'openedBy', (select email from auth.users where id = s.opened_by),
    'cashSales', v_cash, 'supplies', v_in, 'withdrawals', v_out, 'expected', s.opening_amount + v_cash + v_in - v_out,
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'note', note, 'at', at) order by at), '[]') from cash_moves where session_id = s.id),
    'last', v_last);
end $function$;

-- 2. RESERVA DE MESAS ---------------------------------------------------
alter table public.tenants add column if not exists reservations_on boolean not null default false;
alter table public.tenants add column if not exists reservation_capacity integer not null default 20 check (reservation_capacity between 1 and 1000);
alter table public.tenants add column if not exists reservation_max_party integer not null default 12 check (reservation_max_party between 1 and 200);
alter table public.tenants add column if not exists reservation_auto boolean not null default false;
grant select (reservations_on, reservation_max_party) on public.tenants to anon, authenticated;
grant select (reservation_capacity, reservation_auto) on public.tenants to authenticated;
grant update (reservations_on, reservation_capacity, reservation_max_party, reservation_auto) on public.tenants to authenticated;

create table if not exists public.reservations (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null unique default upper(left(replace(gen_random_uuid()::text, '-', ''), 12)),
  name text not null check (char_length(name) between 2 and 80),
  phone text not null check (char_length(phone) between 8 and 20),
  party integer not null check (party between 1 and 200),
  at timestamptz not null,
  note text check (char_length(note) <= 300),
  status text not null default 'pendente' check (status in ('pendente', 'confirmada', 'recusada', 'cancelada', 'chegou', 'faltou')),
  table_label text check (char_length(table_label) <= 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reservations_tenant_at on public.reservations (tenant_id, at);
alter table public.reservations enable row level security;
drop policy if exists "equipe vê reservas" on public.reservations;
create policy "equipe vê reservas" on public.reservations for select using (is_member(tenant_id));
revoke all on public.reservations from anon, authenticated;
grant select on public.reservations to authenticated;

-- Cliente pede a reserva pela loja online
create or replace function public.request_reservation(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; v_at timestamptz; v_party int; v_name text := trim(coalesce(p->>'name', '')); v_phone text := trim(coalesce(p->>'phone', ''));
        v_used int; r reservations;
begin
  perform _rate_limit('resv:' || coalesce(_client_ip(), '-'), 8, interval '10 minutes', 'Muitas tentativas. Aguarde alguns minutos.');
  select * into t from tenants where slug = p_slug and active;
  if t.id is null or not t.reservations_on then raise exception 'Esta loja não aceita reservas pelo site'; end if;
  if not billing_ok(t) then raise exception 'Loja temporariamente indisponível'; end if;
  if char_length(v_name) < 2 then raise exception 'Informe o nome'; end if;
  if phone_key(v_phone) = '' or char_length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then raise exception 'Informe um telefone com DDD'; end if;
  if exists (select 1 from blocked_phones where tenant_id = t.id and phone_key = phone_key(v_phone)) then raise exception 'Não foi possível fazer a reserva. Fale com a loja.'; end if;
  perform _rate_limit('resv-phone:' || t.id || ':' || phone_key(v_phone), 3, interval '1 day', 'Você já pediu reservas demais hoje. Fale com a loja.');
  begin v_at := (p->>'at')::timestamptz; exception when others then raise exception 'Horário inválido'; end;
  if v_at is null or v_at < now() + interval '30 minutes' then raise exception 'Escolha um horário com pelo menos 30 minutos de antecedência'; end if;
  if v_at > now() + interval '60 days' then raise exception 'Reservas até 60 dias à frente'; end if;
  v_party := case when coalesce(p->>'party', '') ~ '^\d{1,3}$' then (p->>'party')::int end;
  if v_party is null or v_party < 1 or v_party > t.reservation_max_party then raise exception 'Reservas pelo site: de 1 a % pessoas. Para grupos maiores, fale com a loja.', t.reservation_max_party; end if;
  t.is_open := true; t.paused_until := null;   -- a pausa de agora não vale para datas futuras
  if not store_open_at(t, v_at) then raise exception 'A loja não abre nesse horário'; end if;
  -- lotação: pessoas com reserva num intervalo de 1h30 para cada lado
  select coalesce(sum(party), 0) into v_used from reservations
    where tenant_id = t.id and status in ('pendente', 'confirmada') and at > v_at - interval '90 minutes' and at < v_at + interval '90 minutes';
  if v_used + v_party > t.reservation_capacity then raise exception 'Esse horário está lotado. Tente outro horário.'; end if;
  insert into reservations (tenant_id, name, phone, party, at, note, status)
    values (t.id, left(v_name, 80), left(v_phone, 20), v_party, v_at, nullif(left(trim(coalesce(p->>'note', '')), 300), ''),
            case when t.reservation_auto then 'confirmada' else 'pendente' end)
    returning * into r;
  return jsonb_build_object('code', r.code, 'status', r.status);
end $$;
revoke execute on function public.request_reservation(text, jsonb) from public;
grant execute on function public.request_reservation(text, jsonb) to anon, authenticated;

-- Página da reserva (pelo código)
create or replace function public.reservation_view(p_code text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('code', r.code, 'name', r.name, 'party', r.party, 'at', r.at, 'note', r.note, 'status', r.status, 'table', r.table_label,
    'canCancel', r.status in ('pendente', 'confirmada') and r.at > now(),
    'store', jsonb_build_object('name', t.name, 'slug', t.slug, 'color', t.color, 'phone', t.phone, 'logo', t.logo_path, 'address', t.address, 'timezone', t.timezone))
  from reservations r join tenants t on t.id = r.tenant_id where r.code = p_code
$$;
revoke execute on function public.reservation_view(text) from public;
grant execute on function public.reservation_view(text) to anon, authenticated;

create or replace function public.reservation_cancel(p_code text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update reservations set status = 'cancelada', updated_at = now() where code = p_code and status in ('pendente', 'confirmada') and at > now();
  if not found then raise exception 'Esta reserva não pode mais ser cancelada'; end if;
end $$;
revoke execute on function public.reservation_cancel(text) from public;
grant execute on function public.reservation_cancel(text) to anon, authenticated;

-- Equipe: confirmar, recusar, marcar chegada ou falta, indicar a mesa
create or replace function public.set_reservation(p_id bigint, p_status text, p_table text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r reservations;
begin
  select * into r from reservations where id = p_id for update;
  if r.id is null or not is_member(r.tenant_id) then raise exception 'Sem permissão'; end if;
  if p_status not in ('pendente', 'confirmada', 'recusada', 'cancelada', 'chegou', 'faltou') then raise exception 'Situação inválida'; end if;
  update reservations set status = p_status, table_label = coalesce(nullif(upper(left(trim(coalesce(p_table, '')), 10)), ''), table_label), updated_at = now() where id = r.id;
end $$;
revoke execute on function public.set_reservation(bigint, text, text) from public, anon;
grant execute on function public.set_reservation(bigint, text, text) to authenticated;

-- Avisa o painel em tempo real quando chega uma reserva nova
do $$ begin
  alter publication supabase_realtime add table public.reservations;
exception when others then null;
end $$;

-- 3. Checagem das migrações
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
    (21, '20261203000000_cashback_atividades.sql',        to_regclass('public.cashback_ledger') is not null),
    (22, '20261204000000_metas_cardapio_chamada.sql',     to_regprocedure('public.call_board(text)') is not null),
    (23, '20261205000000_aceite_reajuste.sql',            to_regprocedure('public.bulk_reprice(uuid, text, numeric, integer, text, boolean, boolean)') is not null),
    (24, '20261206000000_logotipo.sql',                   exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'logo_path')),
    (25, '20261207000000_chamada_nomes.sql',             exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'call_names')),
    (26, '20261208000000_sugestoes_garcom_avisos.sql',   to_regclass('public.push_subscriptions') is not null),
    (27, '20261209000000_totem_indicacao.sql',            to_regclass('public.referral_codes') is not null),
    (28, '20261210000000_entregador_ao_vivo.sql',         to_regprocedure('public.courier_ping(text, double precision, double precision, double precision)') is not null),
    (29, '20261211000000_unidades_notas_produto.sql',     to_regprocedure('public.units_report(integer)') is not null),
    (30, '20261212000000_acerto_entregadores.sql',        to_regclass('public.courier_payouts') is not null),
    (31, '20261213000000_vale_reservas.sql',              to_regclass('public.reservations') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
