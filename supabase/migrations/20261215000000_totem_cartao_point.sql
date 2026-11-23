-- =====================================================================
-- Balcão — cartão no totem pela maquininha Mercado Pago Point (Point Smart / Point Pro 2), API de Orders
-- O sistema manda a cobrança para a maquininha pela internet; o cliente aproxima ou insere o cartão;
-- o Mercado Pago confirma e o pedido entra como pago. Precisa da maquininha em modo integrado (PDV).
-- Rode depois de 20261214000000_totem_pix.sql. Pode rodar de novo sem problema.
-- =====================================================================

alter table public.tenants add column if not exists point_terminal_id text check (point_terminal_id is null or point_terminal_id ~ '^[A-Za-z0-9_-]{4,80}$');
grant select (point_terminal_id) on public.tenants to authenticated;
grant update (point_terminal_id) on public.tenants to authenticated;

alter table public.orders drop constraint if exists orders_payment_check;
alter table public.orders add constraint orders_payment_check
  check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa', 'Dividido', 'Vale-presente', 'Cartão no totem'));

-- Criação de pedidos aceita "Cartão no totem" (só pelo totem)
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
  if v_pay is null or v_pay not in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa', 'Cartão no totem') then raise exception 'Forma de pagamento inválida'; end if;
  if v_pay = 'Cartão no totem' and p_channel <> 'totem' then raise exception 'Forma de pagamento inválida'; end if;
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
          v_sub, v_fee, v_disc, v_total, v_coupon, p_status, case when v_pay in ('Pix online', 'Cartão online', 'Cartão no totem') then 'pending' else 'na' end, v_km, v_lat, v_lng, v_loy, p_channel, v_table, v_sched, v_promo, nullif(array_to_string(v_pnames, ', '), ''), v_service)
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

-- Dados do pedido para a Edge Function (só com a chave de serviço)
CREATE OR REPLACE FUNCTION public.pix_order(p_code text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object('id', o.id, 'number', o.number, 'code', o.public_code, 'total', o.total, 'status', o.status,
    'payment', o.payment, 'paymentStatus', o.payment_status, 'pixRef', o.pix_ref, 'pixQr', o.pix_qr, 'pixQrBase64', o.pix_qr_base64,
    'pixExpiresAt', o.pix_expires_at, 'customerName', o.customer_name, 'tenantId', t.id, 'storeName', t.name, 'storeSlug', t.slug,
    'pixOnline', t.pix_online, 'cardOnline', t.card_online, 'token', tp.mp_access_token, 'pointTerminal', t.point_terminal_id, 'channel', o.channel)
  from orders o join tenants t on t.id = o.tenant_id left join tenant_pix tp on tp.tenant_id = t.id
  where o.public_code = upper(trim(p_code))
$function$;

-- Aplica o pagamento confirmado (Pix, cartão online ou cartão no totem)
CREATE OR REPLACE FUNCTION public.pix_apply(p_tenant uuid, p_order bigint, p_ref text, p_mp_status text, p_amount integer)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o orders;
begin
  select * into o from orders where id = p_order and tenant_id = p_tenant for update;
  if not found or o.payment not in ('Pix online', 'Cartão online', 'Cartão no totem') then raise exception 'Pedido não encontrado'; end if;
  if o.payment_status = 'paid' then return o.status; end if;
  -- No cartão o cliente pode tentar vários cartões (cada tentativa é um pagamento diferente); no Pix o código é um só.
  if o.payment = 'Pix online' and o.pix_ref is not null and o.pix_ref <> p_ref then raise exception 'Pagamento não corresponde ao pedido'; end if;
  if p_mp_status = 'approved' then
    if p_amount <> o.total then raise exception 'Valor pago (%) diferente do total (%)', p_amount, o.total; end if;
    if o.status = 'pagamento' or (o.status = 'cancelado' and o.payment_status = 'expired') then
      update orders set payment_status = 'paid', paid_at = now(), pix_ref = p_ref, status = 'novo', updated_at = now()
      where id = o.id returning * into o;
      insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'novo');
    else
      -- a loja cancelou o pedido antes do pagamento cair: fica registrado como pago para a loja devolver o valor
      update orders set payment_status = 'paid', paid_at = now(), pix_ref = p_ref, updated_at = now() where id = o.id returning * into o;
    end if;
    return o.status;
  elsif o.payment = 'Pix online' and p_mp_status in ('cancelled', 'rejected', 'expired') and o.status = 'pagamento' then
    -- cartão recusado não cancela: o cliente pode tentar outro cartão até o prazo do pedido
    update orders set status = 'cancelado', payment_status = 'expired', updated_at = now() where id = o.id returning * into o;
    insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'cancelado');
  end if;
  return o.status;
end $function$;

-- Guarda a cobrança atual da maquininha (id da order no Mercado Pago)
create or replace function public.point_save(p_order bigint, p_ref text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update orders set pix_ref = p_ref, updated_at = now() where id = p_order and payment = 'Cartão no totem' and payment_status <> 'paid'
$$;
revoke execute on function public.point_save(bigint, text) from public, anon, authenticated;
grant execute on function public.point_save(bigint, text) to service_role;

-- Totem: Pix, cartão na maquininha ou no caixa
create or replace function public.kiosk_place_order(p_tenant uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; o orders; v_pay text := coalesce(p->>'payment', '');
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  if not billing_ok(t) then raise exception 'Loja temporariamente indisponível'; end if;
  if not store_open_at(t, now()) then raise exception 'A loja está fechada agora'; end if;
  if coalesce(p->>'fulfillment', '') <> 'pickup' then raise exception 'No totem, o pedido é para retirar no balcão'; end if;
  if v_pay not in ('Pagar no caixa', 'Pix online', 'Cartão no totem') then raise exception 'No totem, pague com Pix, cartão ou no caixa'; end if;
  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;
  if v_pay = 'Cartão no totem' and (t.point_terminal_id is null or not exists (select 1 from tenant_pix where tenant_id = t.id and mp_access_token is not null)) then
    raise exception 'Nenhuma maquininha configurada para o totem';
  end if;
  p := p - 'scheduledFor' - 'useCashback' - 'coupon';
  o := _create_order(t, p, false, case when v_pay = 'Pagar no caixa' then 'novo' else 'pagamento' end, 'totem');
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'status', (select status from orders where id = o.id), 'payment', o.payment);
end $$;
revoke execute on function public.kiosk_place_order(uuid, jsonb) from public, anon;
grant execute on function public.kiosk_place_order(uuid, jsonb) to authenticated;

-- Checagem das migrações
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
    (31, '20261213000000_vale_reservas.sql',              to_regclass('public.reservations') is not null),
    (32, '20261214000000_totem_pix.sql',                  to_regprocedure('public.kiosk_pay_at_counter(uuid, text)') is not null),
    (33, '20261215000000_totem_cartao_point.sql',         to_regprocedure('public.point_save(bigint, text)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
