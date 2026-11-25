-- 41. Totem: pagamento sempre no próprio totem (Pix ou maquininha)
-- Por padrão, o totem não oferece mais "Pagar no caixa" quando a loja tem Pix online ou maquininha configurados:
-- o cliente paga ali mesmo. O dono pode liberar o caixa de novo em Configurações → Totem.
-- Loja sem Pix online e sem maquininha continua com "Pagar no caixa" (senão o totem não teria como receber).
-- Pode rodar mais de uma vez.

alter table public.tenants add column if not exists kiosk_counter boolean not null default false;
revoke select (kiosk_counter) on public.tenants from anon, authenticated;

-- O totem pode deixar o pagamento para o caixa?
create or replace function public._kiosk_counter_ok(t tenants) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select t.kiosk_counter or not (t.pix_online
    or (t.point_terminal_id is not null and exists (select 1 from tenant_pix where tenant_id = t.id and mp_access_token is not null)))
$$;
revoke execute on function public._kiosk_counter_ok(tenants) from public, anon, authenticated;

create or replace function public.set_kiosk_counter(p_tenant uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_owner(p_tenant) then raise exception 'Sem permissão'; end if;
  update tenants set kiosk_counter = coalesce(p_on, false) where id = p_tenant;
  perform _log(p_tenant, case when p_on then 'Totem: pagar no caixa liberado' else 'Totem: pagamento só no totem' end, null);
end $$;
revoke execute on function public.set_kiosk_counter(uuid, boolean) from public, anon;
grant execute on function public.set_kiosk_counter(uuid, boolean) to authenticated;

do $patch$
declare d text; n text;
begin
  -- pedido do totem: "Pagar no caixa" só se a loja liberou (ou não tem como receber no totem)
  d := replace(pg_get_functiondef('public.kiosk_place_order'::regproc), E'\r\n', E'\n');
  if position('_kiosk_counter_ok' in d) = 0 then
    n := replace(d, $a$  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;$a$,
$b$  if v_pay = 'Pagar no caixa' and not _kiosk_counter_ok(t) then raise exception 'No totem, o pagamento é feito aqui mesmo: Pix ou cartão na maquininha'; end if;
  if v_pay = 'Pix online' and not t.pix_online then raise exception 'Esta loja não aceita Pix online'; end if;$b$);
    if n = d then raise exception 'totem: kiosk_place_order não encontrou o trecho'; end if;
    execute n;
  end if;

  -- trocar Pix/cartão por "pagar no caixa" no meio do pagamento: só se liberado
  d := replace(pg_get_functiondef('public.kiosk_pay_at_counter'::regproc), E'\r\n', E'\n');
  if position('_kiosk_counter_ok' in d) = 0 then
    n := replace(d, $a$  if o.status <> 'pagamento' then return o.status; end if;$a$,
$b$  if o.status <> 'pagamento' then return o.status; end if;
  if not (select _kiosk_counter_ok(t) from tenants t where t.id = p_tenant) then raise exception 'No totem, o pagamento é feito aqui mesmo: Pix ou cartão na maquininha'; end if;$b$);
    if n = d then raise exception 'totem: kiosk_pay_at_counter não encontrou o trecho'; end if;
    execute n;
  end if;

  -- configurações: equipe e totem leem se o caixa está liberado
  d := replace(pg_get_functiondef('public.tenant_settings'::regproc), E'\r\n', E'\n');
  if position('kiosk_counter' in d) = 0 then
    n := replace(d, $a$'point_terminal_id', t.point_terminal_id, 'reservation_auto'$a$, $b$'point_terminal_id', t.point_terminal_id, 'kiosk_counter', _kiosk_counter_ok(t), 'kiosk_counter_set', t.kiosk_counter, 'reservation_auto'$b$);
    if n = d then raise exception 'totem: tenant_settings (equipe) não encontrou o trecho'; end if; d := n;
    n := replace(d, $a$when is_kiosk(p_tenant) then jsonb_build_object('point_terminal_id', t.point_terminal_id)$a$,
      $b$when is_kiosk(p_tenant) then jsonb_build_object('point_terminal_id', t.point_terminal_id, 'kiosk_counter', _kiosk_counter_ok(t))$b$);
    if n = d then raise exception 'totem: tenant_settings (totem) não encontrou o trecho'; end if;
    execute n;
  end if;

  d := replace(pg_get_functiondef('public.schema_status'::regproc), E'\r\n', E'\n');
  if position('20261223000000_totem_so_paga_no_totem.sql' in d) = 0 then
    n := replace(d, $a$and column_name = ''product_id''))$a$, $b$and column_name = ''product_id'')),
    (41, ''20261223000000_totem_so_paga_no_totem.sql'',  to_regprocedure(''public.set_kiosk_counter(uuid, boolean)'') is not null)$b$);
    if n = d then
      n := replace(d, $a$and column_name = 'product_id'))$a$, $b$and column_name = 'product_id')),
    (41, '20261223000000_totem_so_paga_no_totem.sql',  to_regprocedure('public.set_kiosk_counter(uuid, boolean)') is not null)$b$);
    end if;
    if n = d then raise exception 'totem: schema_status não encontrou o trecho'; end if;
    execute n;
  end if;
end $patch$;

notify pgrst, 'reload schema';
