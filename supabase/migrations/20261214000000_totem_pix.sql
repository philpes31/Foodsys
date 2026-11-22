-- =====================================================================
-- Balcão — pagamento por Pix no próprio totem
-- Rode depois de 20261213000000_vale_reservas.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- Totem: pagar no caixa (como antes) ou Pix na hora (QR Code na tela, confirmação automática)
create or replace function public.kiosk_place_order(p_tenant uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; o orders; v_pay text := coalesce(p->>'payment', '');
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  if not billing_ok(t) then raise exception 'Loja temporariamente indisponível'; end if;
  if not store_open_at(t, now()) then raise exception 'A loja está fechada agora'; end if;
  if coalesce(p->>'fulfillment', '') <> 'pickup' then raise exception 'No totem, o pedido é para retirar no balcão'; end if;
  if v_pay not in ('Pagar no caixa', 'Pix online') then raise exception 'No totem, pague com Pix ou no caixa'; end if;
  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;
  p := p - 'scheduledFor' - 'useCashback' - 'coupon';
  o := _create_order(t, p, false, case when v_pay = 'Pix online' then 'pagamento' else 'novo' end, 'totem');
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'status', (select status from orders where id = o.id), 'payment', o.payment);
end $$;
revoke execute on function public.kiosk_place_order(uuid, jsonb) from public, anon;
grant execute on function public.kiosk_place_order(uuid, jsonb) to authenticated;

-- Cliente desistiu do Pix no totem e vai pagar no caixa: o pedido segue normalmente
create or replace function public.kiosk_pay_at_counter(p_tenant uuid, p_code text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into o from orders where tenant_id = p_tenant and public_code = p_code for update;
  if o.id is null or o.channel <> 'totem' then raise exception 'Pedido não encontrado'; end if;
  if o.payment_status = 'paid' then return 'paid'; end if;   -- o Pix caiu antes: nada a fazer
  if o.status <> 'pagamento' then return o.status; end if;
  update orders set payment = 'Pagar no caixa', payment_status = 'na', status = 'novo', updated_at = now() where id = o.id;
  insert into order_events (order_id, tenant_id, status) values (o.id, o.tenant_id, 'novo');
  return 'novo';
end $$;
revoke execute on function public.kiosk_pay_at_counter(uuid, text) from public, anon;
grant execute on function public.kiosk_pay_at_counter(uuid, text) to authenticated;

-- Cliente foi embora sem pagar o Pix: cancela o pedido (o vale-presente usado, se houver, volta)
create or replace function public.kiosk_cancel(p_tenant uuid, p_code text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  if not is_member(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into o from orders where tenant_id = p_tenant and public_code = p_code for update;
  if o.id is null or o.channel <> 'totem' then raise exception 'Pedido não encontrado'; end if;
  if o.payment_status = 'paid' or o.status <> 'pagamento' then return o.status; end if;
  update orders set status = 'cancelado', payment_status = 'expired', updated_at = now() where id = o.id;
  return 'cancelado';
end $$;
revoke execute on function public.kiosk_cancel(uuid, text) from public, anon;
grant execute on function public.kiosk_cancel(uuid, text) to authenticated;

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
    (32, '20261214000000_totem_pix.sql',                  to_regprocedure('public.kiosk_pay_at_counter(uuid, text)') is not null)
  ) as m(n, file, ok);
  return r;
end $$;

notify pgrst, 'reload schema';
