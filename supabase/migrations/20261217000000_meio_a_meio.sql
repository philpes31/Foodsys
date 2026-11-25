-- 35. Pizza meio a meio (sabores fracionados)
-- Um grupo de opções pode cobrar de três jeitos:
--   sum  somar as opções (padrão, como antes: adicionais, bordas)
--   max  cobrar o sabor mais caro (o jeito mais comum nas pizzarias)
--   avg  cobrar a média dos sabores
-- No pedido, os sabores aparecem como "1/2 Calabresa, 1/2 Mussarela" e, no estoque,
-- cada sabor gasta só a sua parte da ficha técnica.
-- Pode rodar mais de uma vez.

alter table public.option_groups add column if not exists pricing text not null default 'sum';
do $$ begin
  alter table public.option_groups add constraint option_groups_pricing_check check (pricing in ('sum', 'max', 'avg'));
exception when duplicate_object then null; end $$;

create or replace function public._fraction(n int) returns text language sql immutable set search_path = public, pg_temp as $$
  select case n when 2 then '1/2' when 3 then '1/3' when 4 then '1/4' else '1/' || n end
$$;

CREATE OR REPLACE FUNCTION public._validate_product(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  g jsonb; o jsonb; v_groups jsonb := '[]'; v_opts jsonb; v_min int; v_max int; v_name text; v_img text;
begin
  if coalesce(trim(p->>'name'), '') = '' or coalesce(trim(p->>'category'), '') = '' then
    raise exception 'Produto precisa de nome e categoria';
  end if;
  if coalesce(p->>'price', '') !~ '^\d{1,7}$' then raise exception 'Preço inválido'; end if;
  v_img := nullif(p->>'image_path', '');
  if v_img is not null and v_img !~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' then raise exception 'Foto inválida'; end if;
  if jsonb_typeof(coalesce(p->'groups', '[]')) <> 'array' or jsonb_array_length(coalesce(p->'groups', '[]')) > 10 then
    raise exception 'Grupos de opções inválidos';
  end if;
  for g in select * from jsonb_array_elements(coalesce(p->'groups', '[]')) loop
    v_name := left(trim(coalesce(g->>'name', '')), 60);
    if v_name = '' then raise exception 'Todo grupo de opções precisa de nome'; end if;
    if jsonb_typeof(g->'options') <> 'array' or jsonb_array_length(g->'options') not between 1 and 40 then
      raise exception 'O grupo "%" precisa de 1 a 40 opções', v_name;
    end if;
    v_opts := '[]';
    for o in select * from jsonb_array_elements(g->'options') loop
      if coalesce(trim(o->>'name'), '') = '' or coalesce(o->>'price', '') !~ '^\d{1,7}$' then
        raise exception 'Opção inválida no grupo "%"', v_name;
      end if;
      v_opts := v_opts || jsonb_build_object('name', left(trim(o->>'name'), 60), 'price', (o->>'price')::int);
    end loop;
    if coalesce(g->>'min_sel', '') !~ '^\d{1,2}$' or coalesce(g->>'max_sel', '') !~ '^\d{1,2}$' then
      raise exception 'Mínimo/máximo inválidos no grupo "%"', v_name;
    end if;
    v_min := (g->>'min_sel')::int; v_max := (g->>'max_sel')::int;
    if v_max < 1 or v_min > v_max or v_min > jsonb_array_length(v_opts) then
      raise exception 'Mínimo/máximo inválidos no grupo "%"', v_name;
    end if;
    if coalesce(nullif(g->>'pricing', ''), 'sum') not in ('sum', 'max', 'avg') then
      raise exception 'Forma de cobrança inválida no grupo "%"', v_name;
    end if;
    v_groups := v_groups || jsonb_build_object('name', v_name, 'min_sel', v_min,
      'max_sel', least(v_max, jsonb_array_length(v_opts)), 'options', v_opts, 'pricing', coalesce(nullif(g->>'pricing', ''), 'sum'));
  end loop;
  return jsonb_build_object(
    'category', left(trim(p->>'category'), 40), 'name', left(trim(p->>'name'), 80),
    'description', left(trim(coalesce(p->>'description', '')), 200), 'price', (p->>'price')::int,
    'icon', coalesce(nullif(p->>'icon', ''), 'box'), 'available', coalesce((p->>'available')::boolean, true),
    'sort', coalesce((p->>'sort')::int, 0), 'image_path', v_img, 'groups', v_groups);
end $function$;

create or replace function public._write_groups(p_tenant uuid, p_product bigint, p_groups jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare g jsonb; o jsonb; v_gid bigint; gi int := 0; oi int; v_pr text;
begin
  delete from option_groups where product_id = p_product;
  for g in select * from jsonb_array_elements(p_groups) loop
    v_pr := coalesce(nullif(g->>'pricing', ''), 'sum');
    if v_pr not in ('sum', 'max', 'avg') then raise exception 'Forma de cobrança inválida em "%"', g->>'name'; end if;
    insert into option_groups (product_id, tenant_id, name, min_sel, max_sel, sort, pricing)
      values (p_product, p_tenant, g->>'name', (g->>'min_sel')::int, (g->>'max_sel')::int, gi, v_pr) returning id into v_gid;
    oi := 0;
    for o in select * from jsonb_array_elements(g->'options') loop
      insert into options (group_id, tenant_id, name, price, sort) values (v_gid, p_tenant, o->>'name', (o->>'price')::int, oi);
      oi := oi + 1;
    end loop;
    gi := gi + 1;
  end loop;
end $$;
revoke all on function public._write_groups(uuid, bigint, jsonb) from public, anon, authenticated;

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
  it jsonb; v_items jsonb := '[]'; v_qty int; v_unit int; v_labels text[]; v_txt text[]; v_chosen bigint[]; v_cnt int; v_add int;
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
    v_unit := pr.price; v_labels := '{}'; v_txt := '{}';
    for g in select * from option_groups where product_id = pr.id order by sort, id loop
      -- sabores fracionados (pizza meio a meio): cobra o mais caro ou a média, em vez de somar
      select count(*), coalesce(case g.pricing when 'max' then max(price) when 'avg' then round(avg(price))::int else sum(price) end, 0)
        into v_cnt, v_add from options where group_id = g.id and id = any(v_chosen);
      if v_cnt < g.min_sel or v_cnt > g.max_sel then
        raise exception 'Escolha entre % e % em "%" (%)', g.min_sel, g.max_sel, g.name, pr.name;
      end if;
      v_unit := v_unit + v_add;
      v_labels := v_labels || array(select name from options where group_id = g.id and id = any(v_chosen) order by sort, id);
      v_txt := v_txt || array(select case when g.pricing <> 'sum' and v_cnt > 1 then _fraction(v_cnt) || ' ' || name else name end
                              from options where group_id = g.id and id = any(v_chosen) order by sort, id);
    end loop;
    -- estoque: baixa na hora (e devolve sozinho se o pedido for cancelado)
    if pr.stock is not null then
      update products set stock = stock - v_qty where id = pr.id and stock >= v_qty;
      if not found then
        select stock into v_left from products where id = pr.id;
        raise exception 'Só restam % unidade(s) de %', greatest(v_left, 0), pr.name;
      end if;
    end if;
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'product_name', pr.name, 'options_text', array_to_string(v_txt, ', '), 'option_names', to_jsonb(v_labels),
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

CREATE OR REPLACE FUNCTION public.create_unit(p_from uuid, p_name text, p_slug text DEFAULT NULL::text)
 RETURNS tenants
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare f tenants; t tenants; pr products; g option_groups; v_pid bigint; v_gid bigint; v_map jsonb := '{}';
begin
  if not is_owner(p_from) then raise exception 'Sem permissão'; end if;
  select * into f from tenants where id = p_from;
  t := create_my_tenant(p_name, f.segment, p_slug, f.color);
  -- configurações da loja de origem (endereço, localização, telefone e domínio ficam para preencher)
  update tenants set min_order = f.min_order, allow_pickup = f.allow_pickup, eta_text = f.eta_text, timezone = f.timezone,
    hours = f.hours, auto_hours = f.auto_hours, delivery_mode = case when f.delivery_mode = 'distance' then 'zones' else f.delivery_mode end,
    distance_tiers = f.distance_tiers, loyalty_enabled = f.loyalty_enabled, loyalty_every = f.loyalty_every, loyalty_percent = f.loyalty_percent,
    allow_tables = f.allow_tables, tables_count = f.tables_count, allow_scheduling = f.allow_scheduling, schedule_days = f.schedule_days,
    schedule_lead_minutes = f.schedule_lead_minutes, schedule_slot_minutes = f.schedule_slot_minutes, description = f.description,
    instagram = f.instagram, free_delivery_above = f.free_delivery_above, plan = f.plan
  where id = t.id returning * into t;
  -- troca o cardápio-modelo pelo cardápio da loja de origem
  delete from products where tenant_id = t.id;
  for pr in select * from products where tenant_id = f.id order by sort, id loop
    insert into products (tenant_id, category, name, description, price, icon, available, sort, image_path, stock)
      values (t.id, pr.category, pr.name, pr.description, pr.price, pr.icon, pr.available, pr.sort, pr.image_path, null)
      returning id into v_pid;
    v_map := v_map || jsonb_build_object(pr.id::text, v_pid);
    for g in select * from option_groups where product_id = pr.id order by sort, id loop
      insert into option_groups (product_id, tenant_id, name, min_sel, max_sel, sort, pricing) values (v_pid, t.id, g.name, g.min_sel, g.max_sel, g.sort, g.pricing) returning id into v_gid;
      insert into options (group_id, tenant_id, name, price, sort) select v_gid, t.id, name, price, sort from options where group_id = g.id order by sort, id;
    end loop;
  end loop;
  delete from zones where tenant_id = t.id;
  insert into zones (tenant_id, name, fee) select t.id, name, fee from zones where tenant_id = f.id order by id;
  insert into promotions (tenant_id, name, kind, product_id, category, buy_qty, pay_qty, percent, days, start_time, end_time, active)
    select t.id, name, kind, (v_map->>product_id::text)::bigint, category, buy_qty, pay_qty, percent, days, start_time, end_time, active
    from promotions where tenant_id = f.id and (product_id is null or v_map ? product_id::text);
  return t;
end $function$;

CREATE OR REPLACE FUNCTION public._ingredients_on_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  with need as (
    select ingredient_id, sum(q) q from (
      select pi.ingredient_id, pi.qty * new.qty q from product_ingredients pi where pi.product_id = new.product_id
      union all
      -- num sabor fracionado (meio a meio), cada sabor gasta só a sua parte da receita
      select oi.ingredient_id, oi.qty * new.qty / coalesce((
          select nullif(count(*), 0) from options o2 join option_groups g2 on g2.id = o2.group_id
          where g2.product_id = new.product_id and g2.pricing <> 'sum' and o2.name = any(new.option_names)
            and g2.id = (select o3.group_id from options o3 join option_groups g3 on g3.id = o3.group_id
                         where g3.product_id = new.product_id and o3.name = oi.option_name order by o3.id limit 1)), 1)
        from option_ingredients oi
        where oi.product_id = new.product_id and oi.option_name = any(coalesce(new.option_names, '{}'))) x
    group by ingredient_id),
  c as (select n.ingredient_id, n.q, i.unit_cost from need n join ingredients i on i.id = n.ingredient_id),
  u as (update ingredients i set stock = i.stock - c.q from c where i.id = c.ingredient_id returning i.id)
  insert into ingredient_moves (ingredient_id, tenant_id, delta, reason, cost_cents, order_id)
    select c.ingredient_id, new.tenant_id, -c.q, 'pedido', -round(c.q * c.unit_cost), new.order_id from c;
  return new;
end $function$;

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
    (33, '20261215000000_totem_cartao_point.sql',         to_regprocedure('public.point_save(bigint, text)') is not null),
    (34, '20261216000000_seguranca_2.sql',                to_regprocedure('public.tenant_settings(uuid)') is not null),
    (35, '20261217000000_meio_a_meio.sql',                exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'option_groups' and column_name = 'pricing'))
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
