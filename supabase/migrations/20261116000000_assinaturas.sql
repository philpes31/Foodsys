-- =====================================================================
-- Balcão — assinatura das lojas (receita da plataforma)
-- 14 dias grátis; depois mensalidade no cartão pelo Mercado Pago (conta do dono da plataforma).
-- Sem pagamento em dia (com 3 dias de carência), a loja para de receber pedidos — o painel continua acessível.
-- Rode depois de 20261115000000_pix_online.sql
-- =====================================================================

alter table public.tenants
  add column billing_status text not null default 'trial' check (billing_status in ('trial', 'active', 'past_due', 'canceled', 'free')),
  add column trial_ends_at timestamptz not null default now() + interval '14 days',
  add column paid_until timestamptz,
  add column mp_preapproval_id text,
  add column billing_updated_at timestamptz;

-- A loja pode vender? (assinatura em dia, teste grátis válido, carência ou liberada pela plataforma)
create function public.billing_ok(t public.tenants, p_at timestamptz default now()) returns boolean
language sql stable as $$
  select case t.billing_status
    when 'free' then true
    when 'trial' then t.trial_ends_at > p_at
    else coalesce(t.paid_until, t.trial_ends_at) + interval '3 days' > p_at
  end
$$;

create or replace function public.place_order(p_slug text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; v_limit int; o orders;
begin
  select * into t from tenants where slug = p_slug and active;
  if not found then raise exception 'Loja não encontrada'; end if;
  if not billing_ok(t) then raise exception 'Esta loja está temporariamente indisponível'; end if;
  if not store_open_at(t) then raise exception 'A loja está fechada no momento'; end if;
  select monthly_orders into v_limit from plans where name = t.plan;
  if v_limit is not null and (select count(*) from orders where tenant_id = t.id and status <> 'pagamento'
      and created_at >= (date_trunc('month', now() at time zone t.timezone) at time zone t.timezone)) >= v_limit then
    raise exception 'A loja atingiu o limite de pedidos do plano neste mês';
  end if;
  o := _create_order(t, p, true, case when p->>'payment' = 'Pix online' then 'pagamento' else 'novo' end);
  return jsonb_build_object('code', o.public_code, 'number', o.number, 'total', o.total, 'pix', o.payment = 'Pix online');
end $$;

-- ---------------------------------------------------------------------
-- Dono da loja
-- ---------------------------------------------------------------------
create function public.billing_info(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t tenants; v_price int;
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  select * into t from tenants where id = p_tenant;
  select price into v_price from plans where name = t.plan;
  return jsonb_build_object('status', t.billing_status, 'ok', billing_ok(t), 'plan', t.plan, 'price', v_price,
    'trialEndsAt', t.trial_ends_at, 'paidUntil', t.paid_until, 'hasSubscription', t.mp_preapproval_id is not null,
    'daysLeft', greatest(0, ceil(extract(epoch from (case when t.billing_status = 'trial' then t.trial_ends_at
                                                          else coalesce(t.paid_until, t.trial_ends_at) end) - now()) / 86400))::int);
end $$;

-- Troca de plano: com assinatura ativa, a função "billing" também atualiza o valor no Mercado Pago.
create or replace function public.change_plan(p_tenant uuid, p_plan text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  if not exists (select 1 from plans where name = p_plan) then raise exception 'Plano inválido'; end if;
  update tenants set plan = p_plan where id = p_tenant;
end $$;

-- ---------------------------------------------------------------------
-- Plataforma (dono do SaaS): liberar grátis, dar dias, mudar status
-- ---------------------------------------------------------------------
create function public.platform_set_billing(p_tenant uuid, p_status text, p_add_days int default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  if p_status not in ('trial', 'active', 'past_due', 'canceled', 'free') then raise exception 'Status inválido'; end if;
  update tenants set billing_status = p_status, billing_updated_at = now(),
    paid_until = case when p_add_days is not null and p_status = 'active'
                      then greatest(coalesce(paid_until, now()), now()) + make_interval(days => p_add_days) else paid_until end,
    trial_ends_at = case when p_add_days is not null and p_status = 'trial'
                         then greatest(trial_ends_at, now()) + make_interval(days => p_add_days) else trial_ends_at end
  where id = p_tenant;
end $$;

create or replace function public.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  with t as (
    select t.*, s.name segment_name, billing_ok(t) can_sell,
      (select count(*) from orders o where o.tenant_id = t.id) n_orders,
      (select coalesce(sum(total), 0) from orders o where o.tenant_id = t.id and o.status not in ('cancelado', 'pagamento')) revenue,
      (select u.email from memberships m join auth.users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' order by m.created_at limit 1) owner_email
    from tenants t join segment_templates s on s.segment = t.segment)
  select jsonb_build_object(
    'mrr', (select coalesce(sum(p.price), 0) from t join plans p on p.name = t.plan where t.active and t.billing_status = 'active'),
    'potentialMrr', (select coalesce(sum(p.price), 0) from t join plans p on p.name = t.plan where t.active and t.billing_status = 'trial' and t.trial_ends_at > now()),
    'trials', (select count(*) from t where t.billing_status = 'trial' and t.trial_ends_at > now()),
    'paying', (select count(*) from t where t.billing_status = 'active'),
    'gmv', (select coalesce(sum(revenue), 0) from t),
    'orders', (select coalesce(sum(n_orders), 0) from t),
    'tenants', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'slug', slug, 'name', name, 'segment', segment, 'segmentName', segment_name,
                 'color', color, 'plan', plan, 'active', active, 'orders', n_orders, 'revenue', revenue, 'ownerEmail', owner_email, 'createdAt', created_at,
                 'billingStatus', billing_status, 'canSell', can_sell, 'trialEndsAt', trial_ends_at, 'paidUntil', paid_until)
                 order by created_at), '[]') from t)) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Funções usadas só pela Edge Function "billing" (chave de serviço)
-- ---------------------------------------------------------------------
create function public.billing_tenant(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'plan', t.plan, 'price', p.price, 'status', t.billing_status,
    'trialEndsAt', t.trial_ends_at, 'paidUntil', t.paid_until, 'preapprovalId', t.mp_preapproval_id,
    'owners', (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'email', u.email)), '[]')
               from memberships m join auth.users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner'))
  from tenants t join plans p on p.name = t.plan where t.id = p_tenant
$$;

create function public.billing_set_preapproval(p_tenant uuid, p_preapproval text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update tenants set mp_preapproval_id = p_preapproval, billing_updated_at = now() where id = p_tenant
$$;

-- Aplica o estado conferido na API do Mercado Pago (authorized / paused / cancelled / pending).
create function public.billing_apply(p_tenant uuid, p_preapproval text, p_mp_status text, p_next_payment timestamptz) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants;
begin
  select * into t from tenants where id = p_tenant for update;
  if not found then raise exception 'Empresa não encontrada'; end if;
  if t.billing_status = 'free' then return t.billing_status; end if;
  if t.mp_preapproval_id is not null and t.mp_preapproval_id <> p_preapproval then
    -- aviso de uma assinatura antiga: só vale se ela estiver ativa (o cliente pode ter assinado de novo)
    if p_mp_status <> 'authorized' then return t.billing_status; end if;
  end if;
  update tenants set
    mp_preapproval_id = p_preapproval,
    billing_updated_at = now(),
    billing_status = case p_mp_status
      when 'authorized' then 'active'
      when 'paused' then 'past_due'
      when 'cancelled' then 'canceled'
      else billing_status end,
    -- vale até a próxima cobrança (se assinou durante o teste grátis, a 1ª cobrança é no fim do teste)
    paid_until = case when p_mp_status = 'authorized' then greatest(coalesce(p_next_payment, now() + interval '1 month'), coalesce(paid_until, now()),
                                                                     case when t.billing_status = 'trial' then t.trial_ends_at end)
                      else paid_until end
  where id = p_tenant returning * into t;
  return t.billing_status;
end $$;

revoke execute on function public.billing_ok(public.tenants, timestamptz) from public, anon;
grant execute on function public.billing_ok(public.tenants, timestamptz) to authenticated;
revoke execute on function public.billing_info(uuid), public.platform_set_billing(uuid, text, int) from public, anon;
grant execute on function public.billing_info(uuid), public.platform_set_billing(uuid, text, int) to authenticated;
revoke execute on function public.billing_tenant(uuid), public.billing_set_preapproval(uuid, text),
  public.billing_apply(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.billing_tenant(uuid), public.billing_set_preapproval(uuid, text),
  public.billing_apply(uuid, text, text, timestamptz) to service_role;
