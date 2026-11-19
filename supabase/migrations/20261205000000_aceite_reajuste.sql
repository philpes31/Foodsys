-- =====================================================================
-- Balcão — aceite automático de pedidos, reajuste de preços em lote e esgotar categoria inteira
-- Rode depois de 20261204000000_metas_cardapio_chamada.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- 1. Aceite automático: pedido que entra (ou que tem o pagamento online confirmado) já vai para "Em preparo"
alter table public.tenants add column if not exists auto_accept boolean not null default false;
grant select (auto_accept) on public.tenants to authenticated;
grant update (auto_accept) on public.tenants to authenticated;

create or replace function public._auto_accept() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status <> 'novo' then return new; end if;
  -- na alteração, só quando o pagamento online acabou de ser confirmado (equipe voltando um pedido para "novo" não é afetada)
  if tg_op = 'UPDATE' and not (new.payment_status = 'paid' and old.payment_status is distinct from 'paid') then return new; end if;
  if new.scheduled_for is not null and new.scheduled_for > now() + interval '30 minutes' then return new; end if;   -- agendado: aceita na hora certa, pela equipe
  if exists (select 1 from tenants where id = new.tenant_id and auto_accept) then new.status := 'preparo'; end if;
  return new;
end $$;
revoke execute on function public._auto_accept() from public, anon, authenticated;
drop trigger if exists orders_auto_accept on public.orders;
create trigger orders_auto_accept before insert or update of status on public.orders for each row execute function public._auto_accept();

-- 2. Reajuste de preços em lote (dono). p_apply = false só mostra a prévia.
--    p_percent: % sobre o preço (pode ser negativo); p_fixed: centavos somados (pode ser negativo);
--    p_round: 'none' | '90' (termina em ,90) | '00' (reais inteiros); p_options: reajusta também opções que custam algo.
create or replace function public._reprice(p_price int, p_percent numeric, p_fixed int, p_round text) returns int
language plpgsql immutable set search_path = public, pg_temp as $$
declare v numeric := p_price * (1 + p_percent / 100.0) + p_fixed;
begin
  if v <= 0 then return 0; end if;
  v := round(v);
  if p_round = '90' then v := ceil((v - 90) / 100.0) * 100 + 90;      -- menor valor terminado em ,90 que não fica abaixo do calculado
  elsif p_round = '00' then v := greatest(100, round(v / 100.0) * 100);
  end if;
  return least(v, 100000000)::int;
end $$;

create or replace function public.bulk_reprice(p_tenant uuid, p_category text, p_percent numeric, p_fixed integer,
                                               p_round text, p_options boolean, p_apply boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_items jsonb; v_n int;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  p_percent := coalesce(p_percent, 0); p_fixed := coalesce(p_fixed, 0); p_round := coalesce(p_round, 'none');
  if p_percent not between -90 and 300 then raise exception 'Percentual deve ficar entre -90%% e 300%%'; end if;
  if p_fixed not between -100000 and 100000 then raise exception 'Valor fixo fora do limite'; end if;
  if p_round not in ('none', '90', '00') then raise exception 'Arredondamento inválido'; end if;
  if p_percent = 0 and p_fixed = 0 then raise exception 'Informe um percentual ou um valor'; end if;

  create temp table if not exists _rp (kind text, id bigint, name text, old_price int, new_price int) on commit drop;
  truncate _rp;
  insert into _rp
    select 'produto', p.id, p.name, p.price, _reprice(p.price, p_percent, p_fixed, p_round)
    from products p where p.tenant_id = p_tenant and p.price > 0 and (p_category is null or p.category = p_category);
  if p_options then
    insert into _rp
      select 'opção', o.id, p.name || ' · ' || o.name, o.price, _reprice(o.price, p_percent, p_fixed, p_round)
      from options o join option_groups g on g.id = o.group_id join products p on p.id = g.product_id
      where p.tenant_id = p_tenant and o.price > 0 and (p_category is null or p.category = p_category);
  end if;
  delete from _rp where new_price = old_price;
  select count(*) into v_n from _rp;
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'name', name, 'old', old_price, 'new', new_price) order by kind desc, name), '[]')
    into v_items from (select * from _rp order by kind desc, name limit 300) x;

  if p_apply and v_n > 0 then
    update products p set price = r.new_price from _rp r where r.kind = 'produto' and p.id = r.id and p.tenant_id = p_tenant;
    update options o set price = r.new_price from _rp r where r.kind = 'opção' and o.id = r.id and o.tenant_id = p_tenant;
    perform _log(p_tenant, 'Reajuste de preços', coalesce(p_category, 'todo o cardápio') || ' · ' || v_n || ' preço(s) · '
      || case when p_percent <> 0 then p_percent || '%' else '' end || case when p_fixed <> 0 then ' ' || _money(p_fixed) else '' end);
  end if;
  return jsonb_build_object('count', v_n, 'items', v_items, 'applied', p_apply and v_n > 0);
end $$;


revoke execute on function public.bulk_reprice(uuid, text, numeric, integer, text, boolean, boolean) from public, anon;
grant execute on function public.bulk_reprice(uuid, text, numeric, integer, text, boolean, boolean) to authenticated;

-- 3. Esgotar / voltar uma categoria inteira (qualquer pessoa da equipe, como no produto)
create or replace function public.set_category_availability(p_tenant uuid, p_category text, p_available boolean) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  update products set available = p_available where tenant_id = p_tenant and category = p_category and available <> p_available;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.set_category_availability(uuid, text, boolean) from public, anon;
grant execute on function public.set_category_availability(uuid, text, boolean) to authenticated;

-- 4. Checagem de migrações
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
    (23, '20261205000000_aceite_reajuste.sql',            to_regprocedure('public.bulk_reprice(uuid, text, numeric, integer, text, boolean, boolean)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
