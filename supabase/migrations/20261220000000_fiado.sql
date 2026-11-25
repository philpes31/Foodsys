-- 38. Fiado (conta do cliente)
-- A loja libera clientes de confiança (pelo telefone), com um limite opcional. A equipe lança pedidos no painel
-- com a forma de pagamento "Fiado"; o valor vai para a conta do cliente. Recebimentos (dinheiro, Pix ou cartão)
-- abatem o saldo; em dinheiro entram na gaveta do caixa. Pedido cancelado estorna sozinho.
-- O cliente nunca escolhe fiado pela loja online: só a equipe, logada no painel.
-- Pode rodar mais de uma vez.

alter table public.tenants add column if not exists fiado_on boolean not null default false;
revoke select (fiado_on) on public.tenants from anon, authenticated;

alter table public.orders drop constraint if exists orders_payment_check;
alter table public.orders add constraint orders_payment_check
  check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa', 'Dividido', 'Vale-presente', 'Cartão no totem', 'Fiado'));

create table if not exists public.credit_accounts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_key text not null check (length(phone_key) between 8 and 11),
  name text not null check (length(name) between 1 and 80),
  credit_limit int check (credit_limit is null or credit_limit >= 0),   -- null = sem limite
  active boolean not null default true,
  note text check (length(note) <= 300),
  created_at timestamptz not null default now(),
  unique (tenant_id, phone_key)
);
create table if not exists public.credit_moves (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id bigint not null references public.credit_accounts(id) on delete cascade,
  kind text not null check (kind in ('compra', 'pagamento', 'estorno', 'ajuste')),
  amount int not null check (amount <> 0),   -- positivo aumenta a dívida, negativo abate
  order_id bigint references public.orders(id) on delete set null,
  method text check (method is null or method in ('Dinheiro', 'Pix', 'Cartão')),
  note text check (length(note) <= 300),
  by_user uuid,
  at timestamptz not null default now()
);
create index if not exists credit_moves_account on public.credit_moves (account_id, at);
create index if not exists credit_moves_tenant_at on public.credit_moves (tenant_id, at);
create unique index if not exists credit_moves_one_charge on public.credit_moves (order_id, kind) where order_id is not null;
alter table public.credit_accounts enable row level security;
alter table public.credit_moves enable row level security;
revoke all on public.credit_accounts, public.credit_moves from anon, authenticated;

create or replace function public._credit_balance(p_account bigint) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(amount), 0)::int from credit_moves where account_id = p_account
$$;

-- Lança o pedido na conta (chamado por _create_order); trava a conta para dois pedidos ao mesmo tempo não passarem do limite
create or replace function public._credit_charge(o orders) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a credit_accounts; v_bal int;
begin
  if not exists (select 1 from tenants where id = o.tenant_id and fiado_on) then raise exception 'Esta loja não trabalha com fiado'; end if;
  select * into a from credit_accounts where tenant_id = o.tenant_id and phone_key = phone_key(o.customer_phone) for update;
  if a.id is null then raise exception 'Este cliente não tem conta de fiado. Cadastre em Caixa → Fiado.'; end if;
  if not a.active then raise exception 'A conta de fiado deste cliente está bloqueada'; end if;
  v_bal := _credit_balance(a.id);
  if a.credit_limit is not null and v_bal + o.total > a.credit_limit then
    raise exception 'Passa do limite do fiado: deve %, limite %, disponível %', _money(v_bal), _money(a.credit_limit), _money(greatest(0, a.credit_limit - v_bal));
  end if;
  insert into credit_moves (tenant_id, account_id, kind, amount, order_id, by_user) values (o.tenant_id, a.id, 'compra', o.total, o.id, auth.uid());
end $$;

-- Pedido em fiado cancelado: estorna uma vez
create or replace function public._credit_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare m credit_moves;
begin
  if new.payment <> 'Fiado' or new.status <> 'cancelado' or old.status = 'cancelado' then return new; end if;
  select * into m from credit_moves where order_id = new.id and kind = 'compra';
  if m.id is null or exists (select 1 from credit_moves where order_id = new.id and kind = 'estorno') then return new; end if;
  insert into credit_moves (tenant_id, account_id, kind, amount, order_id, note, by_user)
    values (new.tenant_id, m.account_id, 'estorno', -m.amount, new.id, 'Pedido #' || new.number || ' cancelado', auth.uid());
  return new;
end $$;
revoke execute on function public._credit_on_status(), public._credit_charge(orders), public._credit_balance(bigint) from public, anon, authenticated;
drop trigger if exists orders_credit_on_status on public.orders;
create trigger orders_credit_on_status after update of status on public.orders for each row execute function public._credit_on_status();

create or replace function public.set_fiado(p_tenant uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  update tenants set fiado_on = coalesce(p_on, false) where id = p_tenant;
  perform _log(p_tenant, case when p_on then 'Fiado ligado' else 'Fiado desligado' end, null);
end $$;

-- Dono cadastra ou altera a conta (telefone, nome, limite, bloqueio)
create or replace function public.credit_account_save(p_tenant uuid, p_id bigint, p_phone text, p_name text, p_limit int, p_active boolean, p_note text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text := phone_key(p_phone); v_name text := left(btrim(coalesce(p_name, '')), 80); v_id bigint;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if length(v_key) < 10 then raise exception 'Telefone inválido (com DDD)'; end if;
  if v_name = '' then raise exception 'Informe o nome do cliente'; end if;
  if p_limit is not null and (p_limit < 0 or p_limit > 100000000) then raise exception 'Limite inválido'; end if;
  if p_id is null then
    insert into credit_accounts (tenant_id, phone_key, name, credit_limit, active, note)
      values (p_tenant, v_key, v_name, p_limit, coalesce(p_active, true), nullif(left(btrim(coalesce(p_note, '')), 300), ''))
      returning id into v_id;
  else
    update credit_accounts set phone_key = v_key, name = v_name, credit_limit = p_limit, active = coalesce(p_active, active),
      note = nullif(left(btrim(coalesce(p_note, '')), 300), '') where id = p_id and tenant_id = p_tenant returning id into v_id;
    if v_id is null then raise exception 'Conta não encontrada'; end if;
  end if;
  perform _log(p_tenant, 'Conta de fiado salva', v_name || coalesce(' · limite ' || _money(p_limit), ' · sem limite'));
  return v_id;
exception when unique_violation then raise exception 'Já existe uma conta de fiado com esse telefone';
end $$;

-- Lista de contas com saldo (equipe toda vê; quem cadastra e muda limite é o dono)
create or replace function public.credit_accounts_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  return jsonb_build_object('on', (select fiado_on from tenants where id = p_tenant),
    'accounts', coalesce((select jsonb_agg(x order by (x->>'balance')::int desc, x->>'name') from (
      select jsonb_build_object('id', a.id, 'name', a.name, 'phone', a.phone_key, 'limit', a.credit_limit, 'active', a.active, 'note', a.note,
        'balance', coalesce(sum(m.amount), 0),
        'lastPayment', max(m.at) filter (where m.kind = 'pagamento'),
        'oldestOpen', (select min(c.at) from credit_moves c where c.account_id = a.id and c.kind = 'compra'
                        and c.at > coalesce((select max(p.at) from credit_moves p where p.account_id = a.id and p.kind = 'pagamento'), '-infinity'::timestamptz))) x
      from credit_accounts a left join credit_moves m on m.account_id = a.id
      where a.tenant_id = p_tenant group by a.id) z), '[]'));
end $$;

-- Na hora de lançar: o cliente desse telefone pode comprar fiado? quanto deve e quanto ainda cabe
create or replace function public.credit_lookup(p_tenant uuid, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a credit_accounts; v_bal int;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if not exists (select 1 from tenants where id = p_tenant and fiado_on) then return null; end if;
  select * into a from credit_accounts where tenant_id = p_tenant and phone_key = phone_key(p_phone);
  if a.id is null then return jsonb_build_object('found', false); end if;
  v_bal := _credit_balance(a.id);
  return jsonb_build_object('found', true, 'id', a.id, 'name', a.name, 'active', a.active, 'balance', v_bal, 'limit', a.credit_limit,
    'available', case when a.credit_limit is null then null else greatest(0, a.credit_limit - v_bal) end);
end $$;

-- Recebimento: abate a dívida. Em dinheiro, entra na gaveta do caixa aberto.
create or replace function public.credit_pay(p_tenant uuid, p_account bigint, p_amount int, p_method text, p_note text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare a credit_accounts; v_bal int;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into a from credit_accounts where id = p_account and tenant_id = p_tenant for update;
  if a.id is null then raise exception 'Conta não encontrada'; end if;
  if p_method not in ('Dinheiro', 'Pix', 'Cartão') then raise exception 'Forma de recebimento inválida'; end if;
  v_bal := _credit_balance(a.id);
  if coalesce(p_amount, 0) <= 0 then raise exception 'Informe o valor recebido'; end if;
  if p_amount > v_bal then raise exception 'Valor maior que a dívida (%)', _money(v_bal); end if;
  if p_method = 'Dinheiro' and not exists (select 1 from cash_sessions where tenant_id = p_tenant and closed_at is null) then
    raise exception 'Abra o caixa para receber em dinheiro';
  end if;
  insert into credit_moves (tenant_id, account_id, kind, amount, method, note, by_user)
    values (p_tenant, a.id, 'pagamento', -p_amount, p_method, nullif(left(btrim(coalesce(p_note, '')), 300), ''), auth.uid());
  perform _log(p_tenant, 'Fiado recebido', a.name || ' · ' || _money(p_amount) || ' · ' || p_method);
  return v_bal - p_amount;
end $$;

-- Ajuste do dono (correção ou perdão de dívida), sempre com motivo
create or replace function public.credit_adjust(p_tenant uuid, p_account bigint, p_amount int, p_note text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare a credit_accounts;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into a from credit_accounts where id = p_account and tenant_id = p_tenant for update;
  if a.id is null then raise exception 'Conta não encontrada'; end if;
  if coalesce(p_amount, 0) = 0 or abs(p_amount) > 100000000 then raise exception 'Informe o valor do ajuste'; end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Escreva o motivo do ajuste'; end if;
  if _credit_balance(a.id) + p_amount < 0 then raise exception 'O ajuste deixaria o saldo negativo'; end if;
  insert into credit_moves (tenant_id, account_id, kind, amount, note, by_user) values (p_tenant, a.id, 'ajuste', p_amount, left(btrim(p_note), 300), auth.uid());
  perform _log(p_tenant, 'Fiado ajustado', a.name || ' · ' || _money(p_amount) || ' · ' || left(btrim(p_note), 80));
  return _credit_balance(a.id);
end $$;

-- Extrato da conta, com o número do pedido
create or replace function public.credit_statement(p_tenant uuid, p_account bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a credit_accounts;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into a from credit_accounts where id = p_account and tenant_id = p_tenant;
  if a.id is null then raise exception 'Conta não encontrada'; end if;
  return jsonb_build_object('id', a.id, 'name', a.name, 'phone', a.phone_key, 'limit', a.credit_limit, 'active', a.active, 'note', a.note,
    'balance', _credit_balance(a.id),
    'moves', coalesce((select jsonb_agg(jsonb_build_object('kind', m.kind, 'amount', m.amount, 'method', m.method, 'note', m.note, 'at', m.at,
        'order', o.number, 'code', o.public_code,
        'by', (select email from auth.users where id = m.by_user)) order by m.at desc, m.id desc)
      from credit_moves m left join orders o on o.id = m.order_id where m.account_id = a.id), '[]'));
end $$;

revoke execute on function public.set_fiado(uuid, boolean), public.credit_account_save(uuid, bigint, text, text, int, boolean, text),
  public.credit_accounts_list(uuid), public.credit_lookup(uuid, text), public.credit_pay(uuid, bigint, int, text, text),
  public.credit_adjust(uuid, bigint, int, text), public.credit_statement(uuid, bigint) from public, anon;
grant execute on function public.set_fiado(uuid, boolean), public.credit_account_save(uuid, bigint, text, text, int, boolean, text),
  public.credit_accounts_list(uuid), public.credit_lookup(uuid, text), public.credit_pay(uuid, bigint, int, text, text),
  public.credit_adjust(uuid, bigint, int, text), public.credit_statement(uuid, bigint) to authenticated;

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
  if v_pay is null or v_pay not in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa', 'Cartão no totem', 'Fiado') then raise exception 'Forma de pagamento inválida'; end if;
  -- fiado: só a equipe lança, num canal do painel, para cliente com conta liberada
  if v_pay = 'Fiado' and (p_channel not in ('balcao', 'telefone', 'mesa') or not is_member(t.id)) then raise exception 'Forma de pagamento inválida'; end if;
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
  if o.payment = 'Fiado' then perform _credit_charge(o); end if;
  insert into order_events (order_id, tenant_id, status, at) values (o.id, t.id, p_status, o.created_at);
  return o;
end $function$;

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
  -- fiado recebido em dinheiro entra na gaveta
  v_cash := v_cash + coalesce((select sum(-amount) from credit_moves where tenant_id = p_tenant and kind = 'pagamento' and method = 'Dinheiro' and at >= s.opened_at), 0);
  select coalesce(sum(amount) filter (where kind = 'suprimento'), 0), coalesce(sum(amount) filter (where kind = 'sangria'), 0) into v_in, v_out
    from cash_moves where session_id = s.id;
  return jsonb_build_object('open', true, 'id', s.id, 'openedAt', s.opened_at, 'opening', s.opening_amount,
    'openedBy', (select email from auth.users where id = s.opened_by),
    'cashSales', v_cash, 'supplies', v_in, 'withdrawals', v_out, 'expected', s.opening_amount + v_cash + v_in - v_out,
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'note', note, 'at', at) order by at), '[]') from cash_moves where session_id = s.id),
    'last', v_last);
end $function$;

CREATE OR REPLACE FUNCTION public.cash_report(p_tenant uuid, p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    'serviceFees', (select coalesce(sum(service_fee), 0) from ok),
    'discounts', (select coalesce(sum(discount + promo_discount), 0) from ok),
    'total', (select coalesce(sum(total), 0) from ok),
    'open', (select count(*) from ok where status not in ('entregue')),
    'cancelled', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(total), 0)) from o where status = 'cancelado'),
    'paidOnline', (select coalesce(sum(total), 0) from ok where payment_status = 'paid'),
    'byPayment', (select coalesce(jsonb_agg(jsonb_build_object('payment', payment, 'count', n, 'total', s) order by s desc), '[]')
                  from (select payment, sum(n)::int n, sum(s)::int s from (
                          select payment, count(*) n, sum(total) s from ok where payment <> 'Dividido' group by payment
                          union all   -- contas de mesa divididas: cada forma de pagamento com o valor que entrou
                          select tp.method, count(*), sum(tp.amount) from table_payments tp
                          where tp.tenant_id = p_tenant and tp.order_ids && (select coalesce(array_agg(id), '{}') from ok) group by tp.method) u
                        group by payment) x),
    'byChannel', (select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'count', n, 'total', s) order by s desc), '[]')
                  from (select channel, count(*) n, sum(total) s from ok group by channel) x),
    'byFulfillment', (select coalesce(jsonb_agg(jsonb_build_object('fulfillment', fulfillment, 'count', n, 'total', s) order by s desc), '[]')
                  from (select fulfillment, count(*) n, sum(total) s from ok group by fulfillment) x),
    'cashChange', (select coalesce(sum(change_for - total), 0) from ok where payment = 'Dinheiro' and change_for is not null),
    'creditReceived', (select coalesce(jsonb_agg(jsonb_build_object('method', method, 'count', n, 'total', s) order by s desc), '[]')
                  from (select method, count(*) n, sum(-amount) s from credit_moves
                        where tenant_id = p_tenant and kind = 'pagamento' and at >= v_from and at < v_to group by method) x)
  ) into r;
  return r;
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
    (35, '20261217000000_meio_a_meio.sql',                exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'option_groups' and column_name = 'pricing')),
    (36, '20261218000000_chamados.sql',                   to_regclass('public.support_tickets') is not null),
    (37, '20261219000000_avisos_loja_erros.sql',          to_regclass('public.client_errors') is not null),
    (38, '20261220000000_fiado.sql',                      to_regclass('public.credit_accounts') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
