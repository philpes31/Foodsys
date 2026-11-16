\set n random(1, 2000)
begin;
set local role anon;
select track_order(code) from bench_codes where n = :n;
commit;
