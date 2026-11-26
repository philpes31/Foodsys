-- 42. E-mails automáticos (Resend)
-- O banco põe cada e-mail numa fila e chama a Edge Function "email" (pela extensão pg_net), que monta o texto
-- e envia pelo Resend. Eventos:
--   * chamado novo ou nova mensagem da loja      -> administração da plataforma
--   * resposta do suporte                          -> quem abriu o chamado
--   * teste grátis acabando (3 dias antes) e assinatura vencida -> dono da loja (uma vez)
--   * resumo do dia anterior (se o dono ligar)    -> dono da loja
-- Os dois últimos rodam uma vez por dia (pg_cron), às 7h de Brasília.
-- Configuração na tela Plataforma: segredo EMAIL_SECRET e chave RESEND_API_KEY nos segredos da função.
-- Pode rodar mais de uma vez.

create table if not exists public.email_queue (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete cascade,
  kind text not null,
  to_email text[] not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
create index if not exists email_queue_created on public.email_queue (created_at desc);
alter table public.email_queue enable row level security;
revoke all on public.email_queue from anon, authenticated;

alter table public.tenants add column if not exists daily_email boolean not null default false;
alter table public.tenants add column if not exists trial_mail_at timestamptz;
alter table public.tenants add column if not exists overdue_mail_at timestamptz;
revoke select (daily_email, trial_mail_at, overdue_mail_at) on public.tenants from anon, authenticated;

-- Chama a função "email" para um item da fila (nunca atrapalha quem chamou)
create or replace function public._email_send(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_secret text;
begin
  select value into v_url from platform_settings where key = 'email_url';
  select value into v_secret from platform_settings where key = 'email_secret';
  if v_url is null or v_secret is null or to_regnamespace('net') is null then return; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using v_url, jsonb_build_object('id', p_id), jsonb_build_object('Content-Type', 'application/json', 'x-email-secret', v_secret);
exception when others then null;
end $$;

create or replace function public._email(p_kind text, p_to text[], p_data jsonb, p_tenant uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint; v_to text[];
begin
  v_to := array(select distinct lower(e) from unnest(p_to) e where e ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$');
  if coalesce(array_length(v_to, 1), 0) = 0 then return null; end if;
  if not exists (select 1 from platform_settings where key = 'email_secret') then return null; end if;   -- e-mail ainda não configurado
  insert into email_queue (tenant_id, kind, to_email, data) values (p_tenant, p_kind, v_to, coalesce(p_data, '{}')) returning id into v_id;
  perform _email_send(v_id);
  return v_id;
exception when others then return null;
end $$;

-- e-mails de quem administra a plataforma / do dono da loja
create or replace function public._admin_emails() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(u.email), '{}') from platform_admins a join auth.users u on u.id = a.user_id where u.email is not null
$$;
create or replace function public._owner_emails(p_tenant uuid) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(u.email), '{}') from memberships m join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant and m.role = 'owner' and u.email is not null
$$;

-- Chamados: mensagem da loja avisa a plataforma; resposta do suporte avisa quem abriu
create or replace function public._email_on_support() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare tk support_tickets; v_store text; v_first boolean;
begin
  select * into tk from support_tickets where id = new.ticket_id;
  select name into v_store from tenants where id = tk.tenant_id;
  if new.from_support then
    perform _email('chamado_resposta', array[(select email from auth.users where id = tk.opened_by)],
      jsonb_build_object('ticket', tk.id, 'subject', tk.subject, 'store', v_store, 'body', left(new.body, 1500)), tk.tenant_id);
  else
    v_first := not exists (select 1 from support_messages where ticket_id = tk.id and id < new.id);
    perform _email(case when v_first then 'chamado_novo' else 'chamado_mensagem' end, _admin_emails(),
      jsonb_build_object('ticket', tk.id, 'subject', tk.subject, 'category', tk.category, 'store', v_store,
        'body', left(new.body, 1500), 'from', (select email from auth.users where id = new.author)), tk.tenant_id);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists support_messages_email on public.support_messages;
create trigger support_messages_email after insert on public.support_messages for each row execute function public._email_on_support();

-- Uma vez por dia: avisos de assinatura e resumo do dia anterior
create or replace function public.email_daily() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare t tenants; n int := 0; v_from timestamptz; v_to timestamptz; v_sum jsonb; v_tz text;
begin
  for t in select * from tenants loop
    -- teste grátis acabando (3 dias antes, uma vez)
    if t.billing_status = 'trial' and t.trial_ends_at is not null and t.trial_ends_at > now() and t.trial_ends_at <= now() + interval '3 days'
       and t.trial_mail_at is null then
      if _email('teste_acabando', _owner_emails(t.id), jsonb_build_object('store', t.name, 'slug', t.slug, 'endsAt', t.trial_ends_at), t.id) is not null then
        update tenants set trial_mail_at = now() where id = t.id; n := n + 1;
      end if;
    end if;
    -- assinatura vencida (uma vez a cada 7 dias enquanto continuar vencida)
    if t.billing_status = 'past_due' and (t.overdue_mail_at is null or t.overdue_mail_at < now() - interval '7 days') then
      if _email('assinatura_vencida', _owner_emails(t.id), jsonb_build_object('store', t.name, 'slug', t.slug, 'paidUntil', t.paid_until), t.id) is not null then
        update tenants set overdue_mail_at = now() where id = t.id; n := n + 1;
      end if;
    end if;
    -- resumo de ontem, no fuso da loja
    if t.daily_email then
      v_tz := coalesce(t.timezone, 'America/Sao_Paulo');
      v_to := (date_trunc('day', now() at time zone v_tz)) at time zone v_tz;
      v_from := v_to - interval '1 day';
      select jsonb_build_object(
          'orders', count(*) filter (where status <> 'cancelado' and status <> 'pagamento'),
          'total', coalesce(sum(total) filter (where status <> 'cancelado' and status <> 'pagamento'), 0),
          'canceled', count(*) filter (where status = 'cancelado'),
          'byPayment', coalesce((select jsonb_agg(jsonb_build_object('payment', payment, 'count', c, 'total', s) order by s desc)
              from (select payment, count(*) c, sum(total) s from orders where tenant_id = t.id and created_at >= v_from and created_at < v_to
                    and status not in ('cancelado', 'pagamento') group by payment) p), '[]'),
          'top', coalesce((select jsonb_agg(jsonb_build_object('name', product_name, 'qty', q) order by q desc)
              from (select oi.product_name, sum(oi.qty) q from order_items oi join orders o on o.id = oi.order_id
                    where o.tenant_id = t.id and o.created_at >= v_from and o.created_at < v_to and o.status not in ('cancelado', 'pagamento')
                    group by oi.product_name order by sum(oi.qty) desc limit 5) x), '[]'))
        into v_sum from orders where tenant_id = t.id and created_at >= v_from and created_at < v_to;
      if _email('resumo_dia', _owner_emails(t.id), v_sum || jsonb_build_object('store', t.name, 'slug', t.slug,
           'date', to_char(v_from at time zone v_tz, 'DD/MM/YYYY')), t.id) is not null then n := n + 1; end if;
    end if;
  end loop;
  delete from email_queue where created_at < now() - interval '90 days';
  return n;
end $$;

-- Função "email" (chave de serviço): pega o item e grava o resultado
create or replace function public.email_take(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare e email_queue;
begin
  update email_queue set sent_at = now() where id = p_id and sent_at is null returning * into e;
  if e.id is null then return null; end if;
  return jsonb_build_object('id', e.id, 'kind', e.kind, 'to', to_jsonb(e.to_email), 'data', e.data);
end $$;
create or replace function public.email_result(p_id bigint, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update email_queue set error = left(p_error, 500) where id = p_id
$$;

-- Plataforma: configurar, ver situação e mandar um teste
create or replace function public.email_setup(p_secret text, p_url text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  if length(coalesce(p_secret, '')) < 32 then raise exception 'Segredo curto demais'; end if;
  if p_url !~ '^https://[^ ]+/functions/v1/email$' then raise exception 'Endereço da função inválido'; end if;
  insert into platform_settings (key, value) values ('email_secret', p_secret), ('email_url', p_url)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return email_status();
end $$;
create or replace function public.email_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  return jsonb_build_object(
    'configured', exists (select 1 from platform_settings where key = 'email_secret'),
    'url', (select value from platform_settings where key = 'email_url'),
    'pgNet', to_regnamespace('net') is not null,
    'cron', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'sent7d', (select count(*) from email_queue where sent_at > now() - interval '7 days' and error is null),
    'failed7d', (select count(*) from email_queue where created_at > now() - interval '7 days' and error is not null),
    'pending', (select count(*) from email_queue where sent_at is null and created_at < now() - interval '2 minutes' and created_at > now() - interval '1 day'),
    'lastError', (select error from email_queue where error is not null order by id desc limit 1));
end $$;
create or replace function public.email_test() returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_platform_admin() then raise exception 'Sem permissão'; end if;
  perform _rate_limit('email-test:' || auth.uid(), 5, interval '10 minutes', 'Muitos testes. Aguarde alguns minutos.');
  return _email('teste', array[(select email from auth.users where id = auth.uid())], jsonb_build_object('at', now()), null);
end $$;

-- Dono liga/desliga o resumo diário
create or replace function public.set_daily_email(p_tenant uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  update tenants set daily_email = coalesce(p_on, false) where id = p_tenant;
end $$;
create or replace function public.daily_email_on(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when is_owner(p_tenant) then (select daily_email from tenants where id = p_tenant) end
$$;

revoke execute on function public._email_send(bigint), public._email(text, text[], jsonb, uuid), public._admin_emails(), public._owner_emails(uuid),
  public._email_on_support(), public.email_daily() from public, anon, authenticated;
revoke execute on function public.email_take(bigint), public.email_result(bigint, text) from public, anon, authenticated;
grant execute on function public.email_take(bigint), public.email_result(bigint, text) to service_role;
revoke execute on function public.email_setup(text, text), public.email_status(), public.email_test(), public.set_daily_email(uuid, boolean), public.daily_email_on(uuid) from public, anon;
grant execute on function public.email_setup(text, text), public.email_status(), public.email_test(), public.set_daily_email(uuid, boolean), public.daily_email_on(uuid) to authenticated;

-- Agenda diária (7h de Brasília = 10h UTC), se o pg_cron existir neste banco
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'balcao-emails-diarios';
    perform cron.schedule('balcao-emails-diarios', '0 10 * * *', 'select public.email_daily()');
  end if;
exception when others then raise notice 'pg_cron indisponível: %', sqlerrm;
end $cron$;

do $patch$
declare d text; n text;
begin
  d := replace(pg_get_functiondef('public.schema_status'::regproc), E'\r\n', E'\n');
  if position('20261224000000_emails.sql' in d) = 0 then
    n := replace(d, $a$to_regprocedure('public.set_kiosk_counter(uuid, boolean)') is not null)$a$, $b$to_regprocedure('public.set_kiosk_counter(uuid, boolean)') is not null),
    (42, '20261224000000_emails.sql',                     to_regclass('public.email_queue') is not null)$b$);
    if n = d then raise exception 'emails: schema_status não encontrou o trecho'; end if;
    execute n;
  end if;
end $patch$;

notify pgrst, 'reload schema';
