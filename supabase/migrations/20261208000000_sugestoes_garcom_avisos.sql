-- =====================================================================
-- Balcão — sugestões escolhidas no carrinho, conta de mesa dividida em várias formas de pagamento
--          e avisos no celular do cliente (notificação do navegador)
-- Rode depois de 20261207000000_chamada_nomes.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Sugestões no carrinho: o dono marca os produtos que quer oferecer ("Leve também")
alter table public.products add column if not exists suggest boolean not null default false;

create or replace function public.set_product_suggest(p_product bigint, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from products where id = p_product;
  if v_tenant is null or not is_owner(v_tenant) then raise exception 'Sem permissão'; end if;
  update products set suggest = coalesce(p_on, false) where id = p_product;
end $$;
revoke execute on function public.set_product_suggest(bigint, boolean) from public, anon;
grant execute on function public.set_product_suggest(bigint, boolean) to authenticated;

-- 2. Conta de mesa dividida: cada pessoa paga a sua parte, em formas de pagamento diferentes
create table if not exists public.table_payments (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  table_label text not null,
  method text not null check (method in ('Dinheiro', 'Pix', 'Cartão na entrega')),
  amount integer not null check (amount > 0),
  order_ids bigint[] not null,
  at timestamptz not null default now(),
  by_user uuid
);
create index if not exists table_payments_tenant_at on public.table_payments (tenant_id, at);
alter table public.table_payments enable row level security;
drop policy if exists "equipe lê pagamentos de mesa" on public.table_payments;
create policy "equipe lê pagamentos de mesa" on public.table_payments for select using (is_member(tenant_id));
revoke all on public.table_payments from anon, authenticated;
grant select on public.table_payments to authenticated;

alter table public.orders drop constraint if exists orders_payment_check;
alter table public.orders add constraint orders_payment_check
  check (payment in ('Pix', 'Cartão na entrega', 'Dinheiro', 'Pix online', 'Cartão online', 'Pagar no caixa', 'Dividido'));

-- p_payments: [{"method":"Pix","amount":4500},{"method":"Dinheiro","amount":3000}] — a soma tem que fechar com a conta
create or replace function public.close_table_split(p_tenant uuid, p_table text, p_payments jsonb) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_table text := upper(trim(coalesce(p_table, ''))); v_ids bigint[]; v_due int; v_sum int := 0; v_methods text[]; x jsonb; n int;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) not between 1 and 30 then raise exception 'Informe de 1 a 30 pagamentos'; end if;
  for x in select * from jsonb_array_elements(p_payments) loop
    if coalesce(x->>'method', '') not in ('Dinheiro', 'Pix', 'Cartão na entrega') then raise exception 'Forma de pagamento inválida'; end if;
    if jsonb_typeof(x->'amount') <> 'number' or (x->>'amount')::numeric <> floor((x->>'amount')::numeric) or (x->>'amount')::int <= 0 then raise exception 'Valor de pagamento inválido'; end if;
    v_sum := v_sum + (x->>'amount')::int;
  end loop;
  select array_agg(id order by id), coalesce(sum(total), 0) into v_ids, v_due from (
    select id, total from orders
    where tenant_id = p_tenant and fulfillment = 'table' and table_label = v_table and settled_at is null
      and status not in ('cancelado', 'pagamento') and created_at > now() - interval '24 hours' and payment_status <> 'paid'
    for update) o;
  if v_ids is null then return close_table(p_tenant, p_table, (p_payments->0->>'method')); end if;   -- tudo já pago online
  if v_sum <> v_due then
    raise exception 'A soma dos pagamentos (%) é diferente do total da conta (%)', _money(v_sum), _money(v_due);
  end if;
  select array_agg(distinct m) into v_methods from (select x2->>'method' m from jsonb_array_elements(p_payments) x2) y;
  if cardinality(v_methods) = 1 then return close_table(p_tenant, p_table, v_methods[1]); end if;   -- uma forma só: igual ao fechamento comum

  n := close_table(p_tenant, p_table, 'Dinheiro');
  update orders set payment = 'Dividido' where id = any(v_ids);
  insert into table_payments (tenant_id, table_label, method, amount, order_ids, by_user)
    select p_tenant, v_table, m, sum(a), v_ids, auth.uid()
    from (select x2->>'method' m, (x2->>'amount')::int a from jsonb_array_elements(p_payments) x2) y group by m;
  return n;
end $$;
revoke execute on function public.close_table_split(uuid, text, jsonb) from public, anon;
grant execute on function public.close_table_split(uuid, text, jsonb) to authenticated;

-- Caixa e relatório do dia passam a contar as partes de cada forma de pagamento
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
    'cashChange', (select coalesce(sum(change_for - total), 0) from ok where payment = 'Dinheiro' and change_for is not null)
  ) into r;
  return r;
end $function$;


-- 3. Avisos no celular do cliente (Web Push)
--    Fluxo: o cliente aceita receber avisos na página do pedido -> quando o status muda, o banco põe o aviso na fila
--    e chama a Edge Function "push" (pela extensão pg_net), que envia para o celular. Sem configuração, nada é enviado.
do $$ begin
  create extension if not exists pg_net;
exception when others then raise notice 'pg_net indisponível aqui; os avisos ficam só na fila';
end $$;

create table if not exists public.platform_settings (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;

create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id bigint not null references public.orders(id) on delete cascade,
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,40}$'),
  created_at timestamptz not null default now(),
  unique (order_id, endpoint)
);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create table if not exists public.push_queue (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id bigint not null references public.orders(id) on delete cascade,
  title text not null, body text not null, url text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.push_queue enable row level security;
revoke all on public.push_queue from anon, authenticated;

-- Chave pública dos avisos (vai para o navegador do cliente)
create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select value from platform_settings where key = 'vapid_public'
$$;
grant execute on function public.push_public_key() to anon, authenticated;

-- Administração da plataforma: grava a chave pública, o segredo compartilhado com a Edge Function e o endereço dela
create or replace function public.push_setup(p_public text, p_secret text, p_url text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  if p_public !~ '^[A-Za-z0-9_-]{86,88}$' then raise exception 'Chave pública inválida'; end if;
  if length(coalesce(p_secret, '')) < 32 then raise exception 'Segredo curto demais'; end if;
  if p_url !~ '^https://[^ ]+/functions/v1/push$' then raise exception 'Endereço da função inválido'; end if;
  insert into platform_settings (key, value) values ('vapid_public', p_public), ('push_secret', p_secret), ('push_url', p_url)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return push_status();
end $$;

create or replace function public.push_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  return jsonb_build_object(
    'configured', exists (select 1 from platform_settings where key = 'push_secret'),
    'publicKey', (select value from platform_settings where key = 'vapid_public'),
    'url', (select value from platform_settings where key = 'push_url'),
    'pgNet', to_regnamespace('net') is not null,
    'subscriptions', (select count(*) from push_subscriptions),
    'sent7d', (select count(*) from push_queue where sent_at > now() - interval '7 days'),
    'pending', (select count(*) from push_queue where sent_at is null and created_at > now() - interval '1 day'));
end $$;
revoke execute on function public.push_setup(text, text, text), public.push_status() from public, anon;
grant execute on function public.push_setup(text, text, text), public.push_status() to authenticated;

-- Cliente aceita os avisos do pedido (pelo código do pedido, sem login)
create or replace function public.push_subscribe(p_code text, p_sub jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  perform _rate_limit('push:' || coalesce(_client_ip(), '-'), 20, interval '10 minutes', 'Muitas tentativas. Aguarde alguns minutos.');
  select * into o from orders where public_code = p_code;
  if o.id is null then raise exception 'Pedido não encontrado'; end if;
  if o.status in ('entregue', 'cancelado') or o.created_at < now() - interval '1 day' then return false; end if;
  if (select count(*) from push_subscriptions where order_id = o.id) >= 5 then return false; end if;
  insert into push_subscriptions (tenant_id, order_id, endpoint, p256dh, auth)
    values (o.tenant_id, o.id, p_sub->>'endpoint', p_sub->'keys'->>'p256dh', p_sub->'keys'->>'auth')
    on conflict (order_id, endpoint) do nothing;
  return true;
exception when check_violation then raise exception 'Inscrição inválida';
end $$;
revoke execute on function public.push_subscribe(text, jsonb) from public;
grant execute on function public.push_subscribe(text, jsonb) to anon, authenticated;

-- Usadas só pela Edge Function (chave de serviço)
create or replace function public.push_take(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare qrow push_queue;
begin
  update push_queue set sent_at = now() where id = p_id and sent_at is null returning * into qrow;
  if qrow.id is null then return null; end if;
  return jsonb_build_object('title', qrow.title, 'body', qrow.body, 'url', qrow.url,
    'subs', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'endpoint', endpoint, 'p256dh', p256dh, 'auth', auth)), '[]')
             from push_subscriptions where order_id = qrow.order_id));
end $$;
create or replace function public.push_drop(p_sub bigint) returns void
language sql security definer set search_path = public, pg_temp as $$ delete from push_subscriptions where id = p_sub $$;
revoke execute on function public.push_take(bigint), public.push_drop(bigint) from public, anon, authenticated;
grant execute on function public.push_take(bigint), public.push_drop(bigint) to service_role;

-- Gatilho: status mudou -> aviso na fila -> chama a Edge Function
create or replace function public._push_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_msg text; v_name text; v_id bigint; v_url text; v_secret text;
begin
  if new.status = old.status then return new; end if;
  if not exists (select 1 from push_subscriptions where order_id = new.id) then return new; end if;
  v_msg := case
    when new.status = 'preparo' and old.status in ('novo', 'pagamento') then 'Pedido #' || new.number || ' aceito! Já está sendo preparado.'
    when new.status = 'pronto' and new.fulfillment = 'pickup' then 'Pedido #' || new.number || ' pronto! Pode retirar no balcão.'
    when new.status = 'pronto' and new.fulfillment = 'table' then 'Pedido #' || new.number || ' pronto! Já vai para a sua mesa.'
    when new.status = 'rota' then 'Pedido #' || new.number || ' saiu para entrega. Está a caminho!'
    when new.status = 'entregue' and new.fulfillment = 'delivery' then 'Pedido #' || new.number || ' entregue. Bom apetite!'
    when new.status = 'cancelado' then 'Pedido #' || new.number || ' foi cancelado. Fale com a loja se tiver dúvidas.'
  end;
  if v_msg is null then return new; end if;
  select name into v_name from tenants where id = new.tenant_id;
  insert into push_queue (tenant_id, order_id, title, body, url) values (new.tenant_id, new.id, v_name, v_msg, '/pedido/' || new.public_code)
    returning id into v_id;
  if random() < 0.01 then delete from push_queue where created_at < now() - interval '7 days'; end if;
  select value into v_url from platform_settings where key = 'push_url';
  select value into v_secret from platform_settings where key = 'push_secret';
  if v_url is not null and v_secret is not null and to_regnamespace('net') is not null then
    begin
      execute 'select net.http_post(url := $1, body := $2, headers := $3)'
        using v_url, jsonb_build_object('id', v_id), jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret);
    exception when others then null;   -- aviso nunca atrapalha a mudança de status
    end;
  end if;
  return new;
end $$;
revoke execute on function public._push_on_status() from public, anon, authenticated;
drop trigger if exists orders_push_on_status on public.orders;
create trigger orders_push_on_status after update of status on public.orders for each row execute function public._push_on_status();

-- 4. Checagem das migrações
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
    (26, '20261208000000_sugestoes_garcom_avisos.sql',   to_regclass('public.push_subscriptions') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
