-- Simula o mínimo do Supabase para rodar a migração e os testes num Postgres comum.
-- NÃO use em produção: o Supabase real já tem tudo isto.

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

create table auth.users (
  id           uuid primary key default gen_random_uuid(),
  email        text,
  is_anonymous boolean not null default false,
  created_at   timestamptz not null default now()
);

-- idênticas às do Supabase
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

-- pg_net falso: registra as chamadas em net.calls (a Edge Function de e-mail não existe nos testes)
create schema if not exists net;
create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                         headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;

create table if not exists net._http_response (id bigint primary key, status_code int, content text, error_msg text);
