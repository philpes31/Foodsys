-- =====================================================================
-- Balcão — controle de caixa por turno, acerto do entregador e bloqueio de clientes
-- Rode depois de 20261129000000_pausa_feriados_estacoes.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Caixa por turno ------------------------------------------------------
create table if not exists public.cash_sessions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  opened_at timestamptz not null default now(),
  opened_by uuid references auth.users(id) on delete set null,
  opening_amount integer not null check (opening_amount >= 0),
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  counted_amount integer check (counted_amount >= 0),
  expected_amount integer,
  note text check (char_length(note) <= 300)
);
create unique index if not exists cash_sessions_one_open on public.cash_sessions (tenant_id) where closed_at is null;
create index if not exists cash_sessions_tenant on public.cash_sessions (tenant_id, opened_at desc);

create table if not exists public.cash_moves (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('sangria', 'suprimento')),
  amount integer not null check (amount > 0),
  note text check (char_length(note) <= 120),
  at timestamptz not null default now(),
  by_user uuid references auth.users(id) on delete set null
);
create index if not exists cash_moves_session on public.cash_moves (session_id);

alter table public.cash_sessions enable row level security;
alter table public.cash_moves enable row level security;
drop policy if exists "equipe lê caixa" on public.cash_sessions;
create policy "equipe lê caixa" on public.cash_sessions for select to authenticated using (is_member(tenant_id));
drop policy if exists "equipe lê movimentos" on public.cash_moves;
create policy "equipe lê movimentos" on public.cash_moves for select to authenticated using (is_member(tenant_id));
revoke all on public.cash_sessions, public.cash_moves from anon, authenticated;
grant select on public.cash_sessions, public.cash_moves to authenticated;

-- Situação do caixa: turno aberto (se houver), movimentos, vendas em dinheiro no turno e o valor esperado na gaveta.
create or replace function public.cash_status(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s cash_sessions; v_cash int; v_in int; v_out int; v_last jsonb;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into s from cash_sessions where tenant_id = p_tenant and closed_at is null;
  select to_jsonb(x) into v_last from (select id, opened_at, closed_at, opening_amount, counted_amount, expected_amount, counted_amount - expected_amount diff, note
    from cash_sessions where tenant_id = p_tenant and closed_at is not null order by closed_at desc limit 1) x;
  if s.id is null then return jsonb_build_object('open', false, 'last', v_last); end if;
  select coalesce(sum(total), 0) into v_cash from orders
    where tenant_id = p_tenant and payment = 'Dinheiro' and status not in ('cancelado', 'pagamento') and created_at >= s.opened_at;
  select coalesce(sum(amount) filter (where kind = 'suprimento'), 0), coalesce(sum(amount) filter (where kind = 'sangria'), 0) into v_in, v_out
    from cash_moves where session_id = s.id;
  return jsonb_build_object('open', true, 'id', s.id, 'openedAt', s.opened_at, 'opening', s.opening_amount,
    'openedBy', (select email from auth.users where id = s.opened_by),
    'cashSales', v_cash, 'supplies', v_in, 'withdrawals', v_out, 'expected', s.opening_amount + v_cash + v_in - v_out,
    'moves', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'note', note, 'at', at) order by at), '[]') from cash_moves where session_id = s.id),
    'last', v_last);
end $$;

create or replace function public.cash_open(p_tenant uuid, p_amount int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if coalesce(p_amount, -1) < 0 then raise exception 'Informe o troco inicial'; end if;
  if exists (select 1 from cash_sessions where tenant_id = p_tenant and closed_at is null) then raise exception 'Já existe um caixa aberto'; end if;
  insert into cash_sessions (tenant_id, opened_by, opening_amount) values (p_tenant, auth.uid(), p_amount);
  return cash_status(p_tenant);
end $$;

create or replace function public.cash_move(p_tenant uuid, p_kind text, p_amount int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select id into v_id from cash_sessions where tenant_id = p_tenant and closed_at is null;
  if v_id is null then raise exception 'Abra o caixa primeiro'; end if;
  if p_kind not in ('sangria', 'suprimento') then raise exception 'Tipo inválido'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Informe o valor'; end if;
  insert into cash_moves (session_id, tenant_id, kind, amount, note, by_user) values (v_id, p_tenant, p_kind, p_amount, nullif(left(trim(coalesce(p_note, '')), 120), ''), auth.uid());
  return cash_status(p_tenant);
end $$;

create or replace function public.cash_close(p_tenant uuid, p_counted int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare st jsonb;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if coalesce(p_counted, -1) < 0 then raise exception 'Informe quanto há em dinheiro na gaveta'; end if;
  st := cash_status(p_tenant);
  if not (st->>'open')::boolean then raise exception 'Nenhum caixa aberto'; end if;
  update cash_sessions set closed_at = now(), closed_by = auth.uid(), counted_amount = p_counted, expected_amount = (st->>'expected')::int,
    note = nullif(left(trim(coalesce(p_note, '')), 300), '')
  where id = (st->>'id')::bigint;
  return cash_status(p_tenant);
end $$;

-- 2. Acerto do entregador -------------------------------------------------
-- Por entregador, no dia: entregas, taxas de entrega (o que a loja repassa) e dinheiro recebido dos clientes (o que ele devolve).
create or replace function public.courier_settlement(p_tenant uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; d date;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select timezone into tz from tenants where id = p_tenant;
  d := coalesce(p_day, (now() at time zone tz)::date);
  return (select coalesce(jsonb_agg(x order by x->>'name'), '[]') from (
    select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone,
      'deliveries', count(o.id) filter (where o.status = 'entregue'),
      'onRoute', count(o.id) filter (where o.status = 'rota'),
      'fees', coalesce(sum(o.fee) filter (where o.status = 'entregue'), 0),
      'cash', coalesce(sum(o.total) filter (where o.status = 'entregue' and o.payment = 'Dinheiro'), 0),
      'card', coalesce(sum(o.total) filter (where o.status = 'entregue' and o.payment = 'Cartão na entrega'), 0),
      'pixOnDelivery', coalesce(sum(o.total) filter (where o.status = 'entregue' and o.payment = 'Pix'), 0),
      'orders', coalesce(jsonb_agg(jsonb_build_object('number', o.number, 'status', o.status, 'payment', o.payment, 'paid', o.payment_status = 'paid', 'total', o.total, 'fee', o.fee) order by o.number) filter (where o.id is not null), '[]')) x
    from couriers c join orders o on o.courier_id = c.id and o.tenant_id = p_tenant
      and (o.created_at at time zone tz)::date = d and o.status in ('rota', 'entregue')
    where c.tenant_id = p_tenant
    group by c.id, c.name, c.phone) s);
end $$;

-- 3. Bloqueio de clientes (trote, golpe) --------------------------------------
create table if not exists public.blocked_phones (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone_key text not null check (phone_key ~ '^\d{8,11}$'),
  note text check (char_length(note) <= 120),
  created_at timestamptz not null default now(),
  primary key (tenant_id, phone_key)
);
alter table public.blocked_phones enable row level security;
drop policy if exists "dono vê bloqueios" on public.blocked_phones;
create policy "dono vê bloqueios" on public.blocked_phones for select to authenticated using (is_owner(tenant_id));
revoke all on public.blocked_phones from anon, authenticated;
grant select on public.blocked_phones to authenticated;

create or replace function public.set_blocked(p_tenant uuid, p_phone text, p_blocked boolean, p_note text default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := phone_key(p_phone);
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if k !~ '^\d{8,11}$' then raise exception 'Telefone inválido'; end if;
  if p_blocked then
    insert into blocked_phones (tenant_id, phone_key, note) values (p_tenant, k, nullif(left(trim(coalesce(p_note, '')), 120), ''))
    on conflict (tenant_id, phone_key) do update set note = excluded.note;
  else
    delete from blocked_phones where tenant_id = p_tenant and phone_key = k;
  end if;
  return p_blocked;
end $$;

CREATE OR REPLACE FUNCTION public.place_order(p_slug text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare t tenants; v_limit int; o orders; v_ip text := _client_ip();
begin
  select * into t from tenants where slug = p_slug and active;
  if not found then raise exception 'Loja não encontrada'; end if;
  perform _rate_limit('order:' || t.id || ':' || coalesce(phone_key(p->'customer'->>'phone'), '-'), 6, interval '10 minutes',
    'Muitos pedidos deste telefone em pouco tempo. Aguarde alguns minutos ou fale com a loja.');
  if v_ip is not null then
    perform _rate_limit('order-ip:' || v_ip, 30, interval '10 minutes', 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.');
  end if;
  if exists (select 1 from blocked_phones b where b.tenant_id = t.id and b.phone_key = phone_key(p->'customer'->>'phone') and phone_key(p->'customer'->>'phone') <> '') then
    raise exception 'Não foi possível concluir o pedido. Fale com a loja.';
  end if;
  if not billing_ok(t) then raise exception 'Esta loja está temporariamente indisponível'; end if;
  -- agendado: a loja pode estar fechada agora (o horário escolhido é conferido em _create_order); só a pausa manual bloqueia
  if nullif(p->>'scheduledFor', '') is null and not store_open_at(t) then raise exception 'A loja está fechada no momento'; end if;
  if nullif(p->>'scheduledFor', '') is not null and not t.is_open then raise exception 'A loja está pausada no momento'; end if;
  select monthly_orders into v_limit from plans where name = t.plan;
  if v_limit is not null and (select count(*) from orders where tenant_id = t.id and status <> 'pagamento'
      and created_at >= (date_trunc('month', now() at time zone t.timezone) at time zone t.timezone)) >= v_limit then
    raise exception 'A loja atingiu o limite de pedidos do plano neste mês';
  end if;
  o := _create_order(t, p, true, case when p->>'payment' in ('Pix online', 'Cartão online') then 'pagamento' else 'novo' end,
                    case when p->>'fulfillment' = 'table' then 'mesa' else 'online' end);
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'pix', o.payment = 'Pix online', 'card', o.payment = 'Cartão online');
end $$;

revoke execute on function public.cash_status(uuid), public.cash_open(uuid, int), public.cash_move(uuid, text, int, text), public.cash_close(uuid, int, text),
  public.courier_settlement(uuid, date), public.set_blocked(uuid, text, boolean, text) from public, anon;
grant execute on function public.cash_status(uuid), public.cash_open(uuid, int), public.cash_move(uuid, text, int, text), public.cash_close(uuid, int, text),
  public.courier_settlement(uuid, date), public.set_blocked(uuid, text, boolean, text) to authenticated;

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
    (16, '20261128000000_vitrine_previsao_mesas.sql',     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'settled_at')),
    (17, '20261129000000_pausa_feriados_estacoes.sql',    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'stations')),
    (18, '20261130000000_caixa_acerto_bloqueio.sql',      to_regclass('public.cash_sessions') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
