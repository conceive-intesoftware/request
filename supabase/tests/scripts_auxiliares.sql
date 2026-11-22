-- Testa os scripts auxiliares (rodado por run.sh num banco limpo, a partir da raiz do projeto).
\set ON_ERROR_STOP on
\set QUIET on

create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$
begin if c is not true then raise exception 'FAIL: %', m; end if; raise notice 'ok - %', m; end $$;

-- ── bootstrap_admin.sql ──
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000000aa', 'Voce@SuaEmpresa.com.br');
\o /dev/null
\i supabase/bootstrap_admin.sql
\o
select pg_temp.ok((select role = 'ADMIN' and active and email = 'voce@suaempresa.com.br' from public.profiles where id = 'a0000000-0000-0000-0000-0000000000aa'), 'bootstrap cria o 1º admin (e-mail case-insensitive)');
\o /dev/null
\i supabase/bootstrap_admin.sql
\o
select pg_temp.ok((select count(*) = 1 from public.profiles), 'bootstrap é idempotente');

-- ── seed_clinics.sql ──
\o /dev/null
\i supabase/seed_clinics.sql
\i supabase/seed_clinics.sql
\o
select pg_temp.ok((select count(*) = 4 from public.clinics), 'seed cria 4 clínicas (e não duplica ao rodar 2x)');
select pg_temp.ok((select count(*) = 4 from public.clinic_units), 'seed cria 1 unidade por clínica');

-- ── cleanup_anonymous_users.sql ──
insert into auth.users (id, email, is_anonymous, created_at) values
  ('b0000000-0000-0000-0000-000000000001', null, true,  now() - interval '40 days'),   -- apagar
  ('b0000000-0000-0000-0000-000000000002', null, true,  now() - interval '5 days'),    -- recente: fica
  ('b0000000-0000-0000-0000-000000000003', null, true,  now() - interval '40 days'),   -- tem arquivo: fica
  ('b0000000-0000-0000-0000-000000000004', 'staff@x.com', false, now() - interval '400 days'); -- não anônimo: fica
insert into storage.objects (bucket_id, name, owner, metadata)
  values ('attachments', 'b0000000-0000-0000-0000-000000000003/x.png', 'b0000000-0000-0000-0000-000000000003', '{}');
\o /dev/null
\i supabase/cleanup_anonymous_users.sql
\o
select pg_temp.ok(not exists (select 1 from auth.users where id = 'b0000000-0000-0000-0000-000000000001'), 'limpeza apaga anônimo antigo sem arquivos');
select pg_temp.ok(exists (select 1 from auth.users where id = 'b0000000-0000-0000-0000-000000000002'), 'limpeza preserva anônimo recente');
select pg_temp.ok(exists (select 1 from auth.users where id = 'b0000000-0000-0000-0000-000000000003'), 'limpeza preserva anônimo com arquivos');
select pg_temp.ok(exists (select 1 from auth.users where id = 'b0000000-0000-0000-0000-000000000004'), 'limpeza preserva usuário não anônimo');
select pg_temp.ok(exists (select 1 from auth.users where id = 'a0000000-0000-0000-0000-0000000000aa'), 'limpeza preserva o admin');

\echo
\echo '=== SCRIPTS AUXILIARES: OK ==='
