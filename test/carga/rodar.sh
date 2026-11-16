#!/usr/bin/env bash
# Teste de carga do banco num Postgres local (16+). Cria o banco "balcao_carga" com 30 lojas e roda o pgbench.
# Uso: PGHOST=... PGPORT=... PGUSER=postgres bash test/carga/rodar.sh [clientes=50] [segundos=30]
set -euo pipefail
cd "$(dirname "$0")/../.."
C=${1:-50}; T=${2:-30}; DB=balcao_carga
dropdb --if-exists $DB; createdb $DB
for f in test/supabase-shim.sql supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d $DB -f "$f" >/dev/null; done
psql -q -d $DB <<'SQL'
alter database balcao_carga set balcao.rate_limit = 'off';
do $$ declare u uuid; i int; begin
  for i in 1..30 loop
    u := gen_random_uuid();
    insert into auth.users (id, email) values (u, 'dono' || i || '@carga.t');
    perform set_config('request.jwt.claim.sub', u::text, true);
    perform create_my_tenant('Loja ' || i, (array['pizzaria','hamburgueria','acai','mercado','farmacia'])[1 + i % 5], 'loja-' || i);
  end loop;
end $$;
update tenants set is_open = true, auto_hours = false, billing_status = 'free', min_order = 0, allow_pickup = true;
update plans set monthly_orders = null;
create table bench_products as select row_number() over () n, t.slug, p.id product_id from products p join tenants t on t.id = p.tenant_id
  where not exists (select 1 from option_groups g where g.product_id = p.id) and p.available;
create table bench_owners as select row_number() over (order by t.slug) n, t.id tenant_id, m.user_id from tenants t join memberships m on m.tenant_id = t.id and m.role = 'owner';
grant select on bench_products, bench_owners to anon, authenticated;
SQL
N=$(psql -d $DB -tAc "select count(*) from bench_products")
pgbench -n -d $DB -D np=$N -f test/carga/pedido.sql -c 10 -j 2 -t 200 >/dev/null   # pedidos iniciais
psql -q -d $DB -c "create table bench_codes as select row_number() over () n, public_code code from (select public_code from orders order by random() limit 2000) x; grant select on bench_codes to anon;"
echo "== Misto: 60% cardápio, 20% acompanhar pedido, 10% novo pedido, 10% painel — $C clientes, ${T}s"
pgbench -n -d $DB -D np=$N -f test/carga/cardapio.sql@6 -f test/carga/acompanhar.sql@2 -f test/carga/pedido.sql@1 -f test/carga/painel.sql@1 -c "$C" -j 2 -T "$T" -r
