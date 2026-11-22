-- =====================================================================
-- ConceIve Requests — migração inicial para Supabase
-- Cole TODO este arquivo no SQL Editor do Supabase e clique em "Run".
-- É idempotente (pode rodar de novo sem quebrar), exceto pelo bootstrap do 1º admin.
--
-- Modelo de segurança (resumo):
--  * Nenhuma tabela é acessível diretamente por anon/authenticated (exceto leitura de
--    clinics/clinic_units/audit_logs para a equipe, via RLS).
--  * TODA leitura/escrita passa por funções RPC (SECURITY DEFINER) que checam permissão,
--    aplicam mascaramento (LGPD) e gravam auditoria.
--  * Equipe exige MFA (aal2) para ter qualquer permissão.
--  * Cliente final usa sessão anônima (Supabase Auth + Turnstile) só para enviar.
-- =====================================================================

create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. Tipos
-- ---------------------------------------------------------------------
do $$ begin create type public.app_role as enum ('ADMIN','PO','SUPPORT','DEV_VIEWER'); exception when duplicate_object then null; end $$;
do $$ begin create type public.requester_role as enum ('DONO_SOCIO','ADMINISTRADOR','RECEPCIONISTA','MEDICO','ENFERMEIRO','FARMACEUTICO','CONTADOR','OUTRO'); exception when duplicate_object then null; end $$;
do $$ begin create type public.request_status as enum ('RECEBIDO','EM_ANALISE_PRODUTO','APROVADO_ROADMAP','EM_DESENVOLVIMENTO','CONCLUIDO','ARQUIVADO'); exception when duplicate_object then null; end $$;
do $$ begin create type public.request_type as enum ('NOVA_FUNCIONALIDADE','MELHORIA_FLUXO','SUGESTAO_TECNICA'); exception when duplicate_object then null; end $$;
do $$ begin create type public.system_module as enum ('FINANCEIRO','AGENDA','PRONTUARIO','ESTOQUE_FARMACIA','FATURAMENTO_TISS','OUTRO'); exception when duplicate_object then null; end $$;
do $$ begin create type public.priority_level as enum ('BAIXA','MEDIA','ALTA','CRITICA'); exception when duplicate_object then null; end $$;
do $$ begin create type public.audit_action as enum ('CREATE','UPDATE','DELETE','EXPORT','LOGIN','VIEW_SENSITIVE'); exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  name        text not null check (length(trim(name)) between 2 and 120),
  role        public.app_role not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role        public.app_role not null,
  permission  text not null,
  primary key (role, permission)
);

create table if not exists public.clinics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 160),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists clinics_name_uq on public.clinics (lower(name));

create table if not exists public.clinic_units (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete restrict,
  name        text not null check (length(trim(name)) between 1 and 160),
  unique (clinic_id, name)
);

create table if not exists public.protocol_counters (
  year  int primary key,
  last  int not null default 0
);

create table if not exists public.requests (
  id                  uuid primary key default gen_random_uuid(),
  protocol            text not null unique,                               -- CON-2026-0088 (trigger)
  tracking_token      text not null unique
                        default substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48),

  clinic_id           uuid references public.clinics(id),
  unit_id             uuid references public.clinic_units(id),
  pending_clinic_name text,
  requester_name      text not null check (length(trim(requester_name)) between 3 and 120),
  requester_role      public.requester_role not null,
  whatsapp_e164       text not null check (whatsapp_e164 ~ '^\+55[0-9]{10,11}$'),

  title               text not null check (length(trim(title)) between 5 and 140),
  description         text not null check (length(trim(description)) between 20 and 8000),  -- texto puro
  module              public.system_module not null,
  type                public.request_type not null,

  status              public.request_status not null default 'RECEBIDO',
  priority            public.priority_level not null default 'MEDIA',

  rice_reach          int check (rice_reach >= 0),
  rice_impact         numeric check (rice_impact in (0.25, 0.5, 1, 2, 3)),
  rice_confidence     numeric check (rice_confidence between 0 and 1),
  rice_effort         numeric check (rice_effort > 0),
  rice_score          numeric generated always as
                        (round((rice_reach * rice_impact * rice_confidence) / nullif(rice_effort, 0), 2)) stored,

  merged_into_id      uuid references public.requests(id),
  external_system     text check (external_system in ('REDMINE','PIPEFY')),
  external_id         text check (length(external_id) <= 80),

  submitted_by        uuid,                       -- auth.uid() de quem enviou (sessão anônima ou staff)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid
);
create index if not exists requests_status_idx     on public.requests (status)      where deleted_at is null;
create index if not exists requests_clinic_idx     on public.requests (clinic_id);
create index if not exists requests_module_idx     on public.requests (module);
create index if not exists requests_priority_idx   on public.requests (priority);
create index if not exists requests_created_idx    on public.requests (created_at desc);
create index if not exists requests_merged_idx     on public.requests (merged_into_id);
create index if not exists requests_submitter_idx  on public.requests (submitted_by, created_at desc);

create table if not exists public.request_attachments (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references public.requests(id),
  file_name     text not null,
  mime_type     text not null,
  size_bytes    bigint not null,
  storage_path  text not null unique,
  created_at    timestamptz not null default now()
);
create index if not exists request_attachments_req_idx on public.request_attachments (request_id);

create table if not exists public.request_comments (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id),
  author_id   uuid not null references public.profiles(id),
  body        text not null check (length(trim(body)) between 1 and 4000),
  is_internal boolean not null default true,       -- false = resposta pública ao cliente
  created_at  timestamptz not null default now()
);
create index if not exists request_comments_req_idx on public.request_comments (request_id, created_at);

create table if not exists public.tags (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique check (length(name) between 1 and 40)
);
create table if not exists public.request_tags (
  request_id  uuid not null references public.requests(id),
  tag_id      uuid not null references public.tags(id),
  primary key (request_id, tag_id)
);

create table if not exists public.audit_logs (
  id              bigint generated always as identity primary key,
  user_id         uuid,                                   -- sem FK de propósito: a trilha sobrevive à exclusão do usuário
  action          public.audit_action not null,
  entity          text not null,
  entity_id       text,
  previous_value  jsonb,
  new_value       jsonb,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index if not exists audit_entity_idx on public.audit_logs (entity, entity_id);
create index if not exists audit_user_idx   on public.audit_logs (user_id, created_at desc);
create index if not exists audit_action_idx on public.audit_logs (action, created_at desc);

-- ---------------------------------------------------------------------
-- 3. RBAC (dirigido por dados)
-- ---------------------------------------------------------------------
insert into public.role_permissions (role, permission)
select r.role::public.app_role, r.permission from (values
  ('ADMIN','request:read'), ('ADMIN','request:create_on_behalf'), ('ADMIN','request:update_status'),
  ('ADMIN','request:prioritize'), ('ADMIN','request:merge'), ('ADMIN','request:export_dev'),
  ('ADMIN','request:archive'), ('ADMIN','request:link_clinic'), ('ADMIN','comment:internal'),
  ('ADMIN','comment:public'), ('ADMIN','pii:view'), ('ADMIN','report:export'), ('ADMIN','audit:read'),
  ('ADMIN','user:manage'), ('ADMIN','clinic:manage'),

  ('PO','request:read'), ('PO','request:create_on_behalf'), ('PO','request:update_status'),
  ('PO','request:prioritize'), ('PO','request:merge'), ('PO','request:export_dev'),
  ('PO','request:archive'), ('PO','request:link_clinic'), ('PO','comment:internal'),
  ('PO','comment:public'), ('PO','pii:view'), ('PO','report:export'), ('PO','audit:read'),

  ('SUPPORT','request:read'), ('SUPPORT','request:create_on_behalf'), ('SUPPORT','request:link_clinic'),
  ('SUPPORT','comment:internal'), ('SUPPORT','comment:public'), ('SUPPORT','pii:view'),

  ('DEV_VIEWER','request:read'), ('DEV_VIEWER','comment:internal')
) as r(role, permission)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 4. Helpers privados (schema "private" não é exposto pela API)
-- ---------------------------------------------------------------------
create or replace function private.req_header(p_name text)
returns text language plpgsql stable set search_path = '' as $$
begin
  return nullif(current_setting('request.headers', true), '')::json ->> p_name;
exception when others then
  return null;
end $$;

create or replace function private.client_ip()
returns text language sql stable set search_path = '' as $$
  select nullif(trim(split_part(coalesce(private.req_header('cf-connecting-ip'),
                                         private.req_header('x-forwarded-for'), ''), ',', 1)), '')
$$;

-- Papel de equipe do usuário atual. Só vale com MFA concluído (aal2).
create or replace function private.staff_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.active
    and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
$$;

create or replace function private.can(p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.role_permissions rp
    where rp.role = private.staff_role() and rp.permission = p_perm
  )
$$;

create or replace function private.require(p_perm text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not private.can(p_perm) then
    raise exception 'forbidden: %', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function private.norm(p text)
returns text language sql immutable set search_path = '' as $$
  select translate(lower(coalesce(p, '')),
    'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
$$;

create or replace function private.normalize_br_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d like '55%' and length(d) >= 12 then d := substr(d, 3); end if;
  if length(d) not in (10, 11) then return null; end if;
  if not (substr(d, 1, 2)::int = any (array[
      11,12,13,14,15,16,17,18,19, 21,22,24,27,28, 31,32,33,34,35,37,38,
      41,42,43,44,45,46,47,48,49, 51,53,54,55, 61,62,63,64,65,66,67,68,69,
      71,73,74,75,77,79, 81,82,83,84,85,86,87,88,89, 91,92,93,94,95,96,97,98,99])) then
    return null;
  end if;
  if length(d) = 11 and substr(d, 3, 1) <> '9' then return null; end if;
  return '+55' || d;
end $$;

create or replace function private.mask_name(p text)
returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg(
    case when length(w) <= 1 then w else left(w, 1) || repeat('*', least(length(w) - 1, 5)) end,
    ' ' order by o), '')
  from regexp_split_to_table(trim(coalesce(p, '')), '\s+') with ordinality as t(w, o)
$$;

create or replace function private.mask_phone(p text)
returns text language sql immutable set search_path = '' as $$
  select '(**) *****-' || right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 4)
$$;

create or replace function private.write_audit(
  p_action public.audit_action, p_entity text, p_entity_id text,
  p_prev jsonb, p_new jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_logs (user_id, action, entity, entity_id, previous_value, new_value, ip_address, user_agent)
  values ((select auth.uid()), p_action, p_entity, p_entity_id, p_prev, p_new,
          private.client_ip(), left(private.req_header('user-agent'), 300));
end $$;

create or replace function private.next_protocol()
returns text language plpgsql security definer set search_path = '' as $$
declare y int := extract(year from now() at time zone 'America/Fortaleza')::int; n int;
begin
  insert into public.protocol_counters (year, last) values (y, 1)
  on conflict (year) do update set last = public.protocol_counters.last + 1
  returning last into n;
  return 'CON-' || y || '-' || lpad(n::text, 4, '0');
end $$;

-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------
-- 5.1 protocolo + updated_at + campos imutáveis
create or replace function private.requests_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.protocol is null or new.protocol = '' then new.protocol := private.next_protocol(); end if;
  else
    new.protocol := old.protocol;                 -- nunca mudam
    new.tracking_token := old.tracking_token;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_requests_before_write on public.requests;
create trigger trg_requests_before_write before insert or update on public.requests
  for each row execute function private.requests_before_write();

-- 5.2 sem DELETE físico
create or replace function private.block_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'DELETE físico proibido em %. Use soft delete (deleted_at/deleted_by).', tg_table_name;
end $$;
drop trigger if exists trg_requests_no_delete on public.requests;
create trigger trg_requests_no_delete before delete on public.requests
  for each row execute function private.block_delete();

-- 5.3 auditoria automática
create or replace function private.audit_row_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare act public.audit_action; rid text; old_j jsonb; new_j jsonb;
begin
  if tg_op = 'INSERT' then
    act := 'CREATE'; new_j := to_jsonb(new); rid := new_j ->> 'id';
  elsif tg_op = 'UPDATE' then
    act := 'UPDATE'; old_j := to_jsonb(old); new_j := to_jsonb(new); rid := new_j ->> 'id';
    if (old_j ? 'deleted_at') and old_j ->> 'deleted_at' is null and new_j ->> 'deleted_at' is not null then
      act := 'DELETE';                              -- soft delete aparece como DELETE na trilha
    end if;
  else
    act := 'DELETE'; old_j := to_jsonb(old); rid := old_j ->> 'id';
  end if;
  insert into public.audit_logs (user_id, action, entity, entity_id, previous_value, new_value, ip_address, user_agent)
  values ((select auth.uid()), act, tg_table_name::text, rid, old_j, new_j,
          private.client_ip(), left(private.req_header('user-agent'), 300));
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['requests','request_comments','clinics','clinic_units','profiles'] loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$s
                    for each row execute function private.audit_row_change()', t);
  end loop;
end $$;

-- 5.4 audit_logs imutável
create or replace function private.audit_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs é imutável (% bloqueado)', tg_op;
end $$;
drop trigger if exists trg_audit_logs_immutable on public.audit_logs;
create trigger trg_audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function private.audit_immutable();
drop trigger if exists trg_audit_logs_no_truncate on public.audit_logs;
create trigger trg_audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.audit_immutable();

-- ---------------------------------------------------------------------
-- 6. RLS (defesa em profundidade; o acesso real é via RPC)
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.role_permissions   enable row level security;
alter table public.clinics            enable row level security;
alter table public.clinic_units       enable row level security;
alter table public.protocol_counters  enable row level security;
alter table public.requests           enable row level security;
alter table public.request_attachments enable row level security;
alter table public.request_comments   enable row level security;
alter table public.tags               enable row level security;
alter table public.request_tags       enable row level security;
alter table public.audit_logs         enable row level security;

drop policy if exists clinics_staff_read on public.clinics;
create policy clinics_staff_read on public.clinics for select to authenticated
  using ((select private.can('request:read')));

drop policy if exists units_staff_read on public.clinic_units;
create policy units_staff_read on public.clinic_units for select to authenticated
  using ((select private.can('request:read')));

drop policy if exists audit_read on public.audit_logs;
create policy audit_read on public.audit_logs for select to authenticated
  using ((select private.can('audit:read')));
-- Sem policies de INSERT/UPDATE/DELETE em nenhuma tabela: toda escrita é via RPC.

-- ---------------------------------------------------------------------
-- 7. Storage (anexos)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 26214400,
        array['image/png','image/jpeg','image/webp','application/pdf','video/mp4','video/webm'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Quantos arquivos o usuário atual já tem no bucket. SECURITY DEFINER porque a RLS de SELECT
-- esconde os objetos de quem não é equipe (a contagem precisa enxergar tudo).
create or replace function private.my_upload_count()
returns bigint language sql stable security definer set search_path = '' as $$
  select count(*) from storage.objects o
  where o.bucket_id = 'attachments' and (storage.foldername(o.name))[1] = (select auth.uid())::text
$$;
grant execute on function private.my_upload_count() to authenticated;

drop policy if exists attachments_insert_own_folder on storage.objects;
create policy attachments_insert_own_folder on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select private.my_upload_count()) < 50);   -- teto por sessão: evita encher o storage

drop policy if exists attachments_staff_read on storage.objects;
create policy attachments_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (select private.can('request:read')));

-- ---------------------------------------------------------------------
-- 8. RPCs públicas (cliente final)
-- ---------------------------------------------------------------------
create or replace function public.search_clinics(p_query text)
returns table (id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := trim(coalesce(p_query, '')); v_pat text;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if length(v_q) < 3 then return; end if;     -- impede listar todas as clínicas
  v_pat := '%' || replace(replace(replace(private.norm(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select c.id, c.name from public.clinics c
    where c.active and private.norm(c.name) like v_pat
    order by c.name limit 8;
end $$;

create or replace function public.list_units(p_clinic_id uuid)
returns table (id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return query
    select u.id, u.name from public.clinic_units u
    join public.clinics c on c.id = u.clinic_id and c.active
    where u.clinic_id = p_clinic_id order by u.name;
end $$;

create or replace function public.submit_request(
  p_clinic_id uuid, p_unit_id uuid, p_pending_clinic_name text,
  p_requester_name text, p_requester_role public.requester_role, p_whatsapp text,
  p_module public.system_module, p_type public.request_type,
  p_title text, p_description text,
  p_attachment_paths text[] default '{}')
returns table (protocol text, tracking_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_phone text; v_clinic uuid := p_clinic_id; v_unit uuid := p_unit_id; v_pending text;
  v_req public.requests; v_path text; v_obj record;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  -- anti-abuso (além do CAPTCHA e do limite de login anônimo por IP do Supabase Auth)
  if (select count(*) from public.requests r where r.submitted_by = v_uid and r.created_at > now() - interval '10 minutes') >= 5
     or (select count(*) from public.requests r where r.submitted_by = v_uid and r.created_at > now() - interval '1 day') >= 30 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  if p_requester_role is null or p_module is null or p_type is null then raise exception 'invalid_input'; end if;
  if length(trim(coalesce(p_requester_name, ''))) not between 3 and 120 then raise exception 'invalid_name'; end if;
  if length(trim(coalesce(p_title, ''))) not between 5 and 140 then raise exception 'invalid_title'; end if;
  if length(trim(coalesce(p_description, ''))) not between 20 and 8000 then raise exception 'invalid_description'; end if;

  v_phone := private.normalize_br_phone(p_whatsapp);
  if v_phone is null then raise exception 'invalid_phone'; end if;

  if v_clinic is not null then
    if not exists (select 1 from public.clinics c where c.id = v_clinic and c.active) then
      raise exception 'invalid_clinic';
    end if;
    if v_unit is not null and not exists (select 1 from public.clinic_units u where u.id = v_unit and u.clinic_id = v_clinic) then
      v_unit := null;
    end if;
  else
    v_unit := null;
    v_pending := trim(coalesce(p_pending_clinic_name, ''));
    if length(v_pending) < 3 or length(v_pending) > 160 then raise exception 'clinic_required'; end if;
  end if;

  if coalesce(array_length(p_attachment_paths, 1), 0) > 5 then raise exception 'too_many_attachments'; end if;

  insert into public.requests (clinic_id, unit_id, pending_clinic_name, requester_name, requester_role,
                               whatsapp_e164, title, description, module, type, submitted_by)
  values (v_clinic, v_unit, v_pending, trim(p_requester_name), p_requester_role,
          v_phone, trim(p_title), trim(p_description), p_module, p_type, v_uid)
  returning * into v_req;

  foreach v_path in array coalesce(p_attachment_paths, '{}') loop
    -- só aceita arquivos que EXISTEM no bucket e estão na pasta do próprio usuário
    if v_path not like v_uid::text || '/%' then raise exception 'invalid_attachment'; end if;
    select o.name, o.metadata into v_obj from storage.objects o
      where o.bucket_id = 'attachments' and o.name = v_path;
    if not found then raise exception 'invalid_attachment'; end if;
    insert into public.request_attachments (request_id, file_name, mime_type, size_bytes, storage_path)
    values (v_req.id,
            left(case when position('__' in v_path) > 0 then substr(v_path, position('__' in v_path) + 2) else v_path end, 120),
            coalesce(v_obj.metadata ->> 'mimetype', 'application/octet-stream'),
            coalesce((v_obj.metadata ->> 'size')::bigint, 0),
            v_path);
  end loop;

  return query select v_req.protocol, v_req.tracking_token;
end $$;

-- Acompanhamento sem login: o token (192 bits) é o segredo. Retorna só dados não sensíveis.
create or replace function public.get_request_by_token(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.requests;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then return null; end if;
  select * into r from public.requests where tracking_token = p_token;
  if not found then return null; end if;
  return jsonb_build_object(
    'protocol', r.protocol,
    'title', r.title,
    'status', case when r.deleted_at is not null then 'ARQUIVADO' else r.status end,
    'module', r.module,
    'type', r.type,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'comments', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'created_at', c.created_at)
                                           order by c.created_at), '[]'::jsonb)
                 from public.request_comments c where c.request_id = r.id and not c.is_internal));
end $$;

-- ---------------------------------------------------------------------
-- 9. RPCs da equipe
-- ---------------------------------------------------------------------
create or replace function public.my_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role public.app_role := private.staff_role(); v_name text;
begin
  if v_role is not null then
    select p.name into v_name from public.profiles p where p.id = (select auth.uid());
  end if;
  return jsonb_build_object(
    'uid', (select auth.uid()),
    'role', v_role,
    'name', v_name,
    'aal', (select auth.jwt()) ->> 'aal',
    'is_anonymous', coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false),
    'permissions', coalesce((select jsonb_agg(rp.permission order by rp.permission)
                             from public.role_permissions rp where rp.role = v_role), '[]'::jsonb));
end $$;

create or replace function public.log_login()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.staff_role() is not null then
    perform private.write_audit('LOGIN', 'profiles', (select auth.uid())::text, null, null);
  end if;
end $$;

-- Filtro compartilhado por list_requests / export_requests (não exposto)
create or replace function private.filtered_requests(p_filters jsonb)
returns setof public.requests language plpgsql stable security definer set search_path = '' as $$
declare
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text := nullif(trim(f ->> 'q'), '');
  v_pat text;
  v_pii boolean := private.can('pii:view');
  v_clinic uuid := nullif(f ->> 'clinic_id', '')::uuid;
  v_role public.requester_role := nullif(f ->> 'requester_role', '')::public.requester_role;
  v_module public.system_module := nullif(f ->> 'module', '')::public.system_module;
  v_status public.request_status := nullif(f ->> 'status', '')::public.request_status;
  v_priority public.priority_level := nullif(f ->> 'priority', '')::public.priority_level;
  v_from timestamptz := case when nullif(f ->> 'from', '') is null then null
                             else ((f ->> 'from')::date)::timestamp at time zone 'America/Fortaleza' end;
  v_to timestamptz := case when nullif(f ->> 'to', '') is null then null
                           else (((f ->> 'to')::date + 1)::timestamp at time zone 'America/Fortaleza') end;
begin
  if v_q is not null then
    v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
    select r.* from public.requests r
    where r.deleted_at is null
      and (v_clinic is null or r.clinic_id = v_clinic)
      and (v_role is null or r.requester_role = v_role)
      and (v_module is null or r.module = v_module)
      and (v_status is null or r.status = v_status)
      and (v_priority is null or r.priority = v_priority)
      and (v_from is null or r.created_at >= v_from)
      and (v_to is null or r.created_at < v_to)
      and (v_pat is null or r.title ilike v_pat or r.protocol ilike v_pat
           or (v_pii and r.requester_name ilike v_pat))
    order by r.created_at desc;
end $$;

create or replace function public.list_requests(
  p_filters jsonb default '{}'::jsonb, p_page int default 1, p_page_size int default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_pii boolean; v_total bigint; v_rows jsonb;
  v_size int := least(greatest(coalesce(p_page_size, 25), 1), 200);
  v_page int := greatest(coalesce(p_page, 1), 1);
begin
  perform private.require('request:read');
  v_pii := private.can('pii:view');
  select count(*) into v_total from private.filtered_requests(p_filters);
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb) into v_rows from (
    select r.created_at,
      jsonb_build_object(
        'id', r.id, 'protocol', r.protocol, 'title', r.title, 'status', r.status,
        'priority', r.priority, 'module', r.module, 'type', r.type,
        'requester_name', case when v_pii then r.requester_name else private.mask_name(r.requester_name) end,
        'requester_role', r.requester_role,
        'whatsapp', case when v_pii then r.whatsapp_e164 else private.mask_phone(r.whatsapp_e164) end,
        'pii_masked', not v_pii,
        'clinic_id', r.clinic_id, 'clinic_name', c.name, 'pending_clinic_name', r.pending_clinic_name,
        'rice_score', r.rice_score, 'merged_into_id', r.merged_into_id,
        'duplicates_count', (select count(*) from public.requests d where d.merged_into_id = r.id and d.deleted_at is null),
        'created_at', r.created_at) as j
    from private.filtered_requests(p_filters) r
    left join public.clinics c on c.id = r.clinic_id
    order by r.created_at desc
    offset (v_page - 1) * v_size limit v_size
  ) x;
  return jsonb_build_object('total', v_total, 'page', v_page, 'page_size', v_size, 'rows', v_rows);
end $$;

create or replace function public.get_request_detail(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.requests; v_pii boolean; v_audit jsonb := null;
begin
  perform private.require('request:read');
  select * into r from public.requests where id = p_id and deleted_at is null;
  if not found then return null; end if;
  v_pii := private.can('pii:view');

  -- quem vê dado pessoal sem máscara deixa rastro (LGPD)
  if v_pii then
    perform private.write_audit('VIEW_SENSITIVE', 'requests', r.id::text, null,
      jsonb_build_object('fields', jsonb_build_array('requester_name', 'whatsapp_e164')));
  end if;

  if private.can('audit:read') then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'action', a.action, 'entity', a.entity, 'created_at', a.created_at,
        'ip', a.ip_address, 'user_agent', a.user_agent,
        'user', coalesce(p.name || ' (' || p.role::text || ')', 'Cliente / sistema'),
        'previous', case when v_pii then a.previous_value else a.previous_value - 'requester_name' - 'whatsapp_e164' end,
        'next', case when v_pii then a.new_value else a.new_value - 'requester_name' - 'whatsapp_e164' end)
      order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_audit
    from (
      select * from public.audit_logs l
      where (l.entity = 'requests' and l.entity_id = r.id::text)
         or (l.entity = 'request_comments'
             and (l.new_value ->> 'request_id' = r.id::text or l.previous_value ->> 'request_id' = r.id::text))
      order by l.created_at desc, l.id desc limit 100
    ) a left join public.profiles p on p.id = a.user_id;
  end if;

  return jsonb_build_object(
    'id', r.id, 'protocol', r.protocol, 'title', r.title, 'description', r.description,
    'status', r.status, 'priority', r.priority, 'module', r.module, 'type', r.type,
    'requester_name', case when v_pii then r.requester_name else private.mask_name(r.requester_name) end,
    'requester_role', r.requester_role,
    'whatsapp', case when v_pii then r.whatsapp_e164 else private.mask_phone(r.whatsapp_e164) end,
    'pii_masked', not v_pii,
    'clinic_id', r.clinic_id,
    'clinic_name', (select c.name from public.clinics c where c.id = r.clinic_id),
    'unit_name', (select u.name from public.clinic_units u where u.id = r.unit_id),
    'pending_clinic_name', r.pending_clinic_name,
    'rice', jsonb_build_object('reach', r.rice_reach, 'impact', r.rice_impact,
                               'confidence', r.rice_confidence, 'effort', r.rice_effort, 'score', r.rice_score),
    'external_system', r.external_system, 'external_id', r.external_id,
    'merged_into', (select jsonb_build_object('id', m.id, 'protocol', m.protocol)
                    from public.requests m where m.id = r.merged_into_id),
    'created_at', r.created_at, 'updated_at', r.updated_at,
    'attachments', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name,
                        'mime_type', a.mime_type, 'size_bytes', a.size_bytes, 'storage_path', a.storage_path)
                        order by a.created_at), '[]'::jsonb)
                    from public.request_attachments a where a.request_id = r.id),
    'comments', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'is_internal', c.is_internal,
                        'created_at', c.created_at, 'author_name', p.name, 'author_role', p.role)
                        order by c.created_at), '[]'::jsonb)
                 from public.request_comments c left join public.profiles p on p.id = c.author_id
                 where c.request_id = r.id),
    'duplicates', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'protocol', d.protocol, 'title', d.title,
                        'clinic_name', cc.name) order by d.created_at), '[]'::jsonb)
                   from public.requests d left join public.clinics cc on cc.id = d.clinic_id
                   where d.merged_into_id = r.id and d.deleted_at is null),
    'tags', (select coalesce(jsonb_agg(t.name order by t.name), '[]'::jsonb)
             from public.request_tags rt join public.tags t on t.id = rt.tag_id where rt.request_id = r.id),
    'audit', v_audit);
end $$;

create or replace function public.set_request_status(p_id uuid, p_status public.request_status)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('request:update_status');
  update public.requests set status = p_status where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.set_request_priority(
  p_id uuid, p_priority public.priority_level,
  p_reach int, p_impact numeric, p_confidence numeric, p_effort numeric)
returns numeric language plpgsql security definer set search_path = '' as $$
declare v_score numeric;
begin
  perform private.require('request:prioritize');
  update public.requests
     set priority = p_priority, rice_reach = p_reach, rice_impact = p_impact,
         rice_confidence = p_confidence, rice_effort = p_effort
   where id = p_id and deleted_at is null
   returning rice_score into v_score;
  if not found then raise exception 'not_found'; end if;
  return v_score;
end $$;

create or replace function public.set_request_tags(p_id uuid, p_tags text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text; v_tag uuid;
begin
  perform private.require('request:prioritize');
  if not exists (select 1 from public.requests where id = p_id and deleted_at is null) then raise exception 'not_found'; end if;
  if coalesce(array_length(p_tags, 1), 0) > 10 then raise exception 'too_many_tags'; end if;
  delete from public.request_tags where request_id = p_id;
  foreach v_name in array coalesce(p_tags, '{}') loop
    v_name := lower(trim(v_name));
    continue when v_name = '';
    insert into public.tags (name) values (left(v_name, 40)) on conflict (name) do update set name = excluded.name
      returning id into v_tag;
    insert into public.request_tags (request_id, tag_id) values (p_id, v_tag) on conflict do nothing;
  end loop;
end $$;

create or replace function public.add_comment(p_request_id uuid, p_body text, p_internal boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require(case when coalesce(p_internal, true) then 'comment:internal' else 'comment:public' end);
  if length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_comment'; end if;
  if not exists (select 1 from public.requests where id = p_request_id and deleted_at is null) then raise exception 'not_found'; end if;
  insert into public.request_comments (request_id, author_id, body, is_internal)
  values (p_request_id, (select auth.uid()), trim(p_body), coalesce(p_internal, true))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.archive_request(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('request:archive');
  update public.requests
     set deleted_at = now(), deleted_by = (select auth.uid()), status = 'ARQUIVADO'
   where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.merge_request(p_id uuid, p_into uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_src public.requests; v_tgt public.requests;
begin
  perform private.require('request:merge');
  if p_id = p_into then raise exception 'invalid_merge'; end if;
  select * into v_src from public.requests where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  select * into v_tgt from public.requests where id = p_into and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  if v_tgt.merged_into_id is not null then                  -- sempre aponta para a "mãe" raiz
    select * into v_tgt from public.requests where id = v_tgt.merged_into_id;
  end if;
  if v_tgt.id = v_src.id then raise exception 'invalid_merge'; end if;
  update public.requests set merged_into_id = v_tgt.id where merged_into_id = v_src.id;   -- filhas da origem
  update public.requests set merged_into_id = v_tgt.id where id = v_src.id;
end $$;

create or replace function public.unmerge_request(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('request:merge');
  update public.requests set merged_into_id = null where id = p_id;
end $$;

create or replace function public.link_request_clinic(p_id uuid, p_clinic_id uuid, p_unit_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_unit uuid := p_unit_id;
begin
  perform private.require('request:link_clinic');
  if not exists (select 1 from public.clinics where id = p_clinic_id) then raise exception 'invalid_clinic'; end if;
  if v_unit is not null and not exists (select 1 from public.clinic_units where id = v_unit and clinic_id = p_clinic_id) then
    v_unit := null;
  end if;
  update public.requests set clinic_id = p_clinic_id, unit_id = v_unit, pending_clinic_name = null
   where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.set_external_ref(p_id uuid, p_system text, p_external_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('request:export_dev');
  if nullif(p_system, '') is not null and p_system not in ('REDMINE', 'PIPEFY') then raise exception 'invalid_system'; end if;
  update public.requests
     set external_system = nullif(p_system, ''), external_id = nullif(trim(p_external_id), '')
   where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;

-- Exportação: sem dados pessoais do solicitante (minimização) e SEMPRE auditada.
create or replace function public.export_requests(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb; v_n int;
begin
  perform private.require('report:export');
  select coalesce(jsonb_agg(jsonb_build_object(
      'protocolo', r.protocol, 'titulo', r.title,
      'clinica', coalesce(c.name, r.pending_clinic_name), 'modulo', r.module, 'tipo', r.type,
      'status', r.status, 'prioridade', r.priority, 'rice', r.rice_score,
      'sistema_externo', r.external_system, 'id_externo', r.external_id,
      'criado_em', r.created_at) order by r.created_at desc), '[]'::jsonb)
    into v_rows
  from (select * from private.filtered_requests(p_filters) limit 5000) r
  left join public.clinics c on c.id = r.clinic_id;
  v_n := jsonb_array_length(v_rows);
  perform private.write_audit('EXPORT', 'requests', null, null,
    jsonb_build_object('filters', coalesce(p_filters, '{}'::jsonb), 'row_count', v_n));
  return v_rows;
end $$;

-- ---------------------------------------------------------------------
-- 10. RPCs de administração
-- ---------------------------------------------------------------------
create or replace function public.admin_list_staff()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('user:manage');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name,
                          'role', p.role, 'active', p.active) order by p.name), '[]'::jsonb) from public.profiles p);
end $$;

-- O usuário precisa existir em Authentication → Users (convite/criação no painel do Supabase).
create or replace function public.admin_upsert_staff(
  p_email text, p_name text, p_role public.app_role, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  perform private.require('user:manage');
  select u.id into v_uid from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_uid is null then raise exception 'user_not_found'; end if;
  if exists (select 1 from public.profiles where id = v_uid and role = 'ADMIN' and active)
     and (p_role <> 'ADMIN' or not coalesce(p_active, true))
     and not exists (select 1 from public.profiles where role = 'ADMIN' and active and id <> v_uid) then
    raise exception 'last_admin';
  end if;
  insert into public.profiles (id, email, name, role, active)
  values (v_uid, lower(trim(p_email)), trim(p_name), p_role, coalesce(p_active, true))
  on conflict (id) do update
    set name = excluded.name, role = excluded.role, active = excluded.active, email = excluded.email;
  return v_uid;
end $$;

create or replace function public.admin_upsert_clinic(p_id uuid, p_name text, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require('clinic:manage');
  if p_id is null then
    insert into public.clinics (name, active) values (trim(p_name), coalesce(p_active, true)) returning id into v_id;
  else
    update public.clinics set name = trim(p_name), active = coalesce(p_active, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.admin_add_unit(p_clinic_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require('clinic:manage');
  insert into public.clinic_units (clinic_id, name) values (p_clinic_id, trim(p_name)) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 11. Privilégios (default do Supabase é permissivo — aqui fechamos tudo)
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.my_upload_count() to authenticated;   -- (o revoke acima também a atinge)
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

grant select on public.clinics, public.clinic_units, public.audit_logs to authenticated;

-- usadas dentro de policies RLS (avaliadas com o papel de quem consulta)
grant execute on function private.can(text), private.staff_role() to authenticated;

-- tracking público (anon key, sem sessão)
grant execute on function public.get_request_by_token(text) to anon, authenticated;

grant execute on function
  public.search_clinics(text),
  public.list_units(uuid),
  public.submit_request(uuid, uuid, text, text, public.requester_role, text, public.system_module, public.request_type, text, text, text[]),
  public.my_context(),
  public.log_login(),
  public.list_requests(jsonb, int, int),
  public.get_request_detail(uuid),
  public.set_request_status(uuid, public.request_status),
  public.set_request_priority(uuid, public.priority_level, int, numeric, numeric, numeric),
  public.set_request_tags(uuid, text[]),
  public.add_comment(uuid, text, boolean),
  public.archive_request(uuid),
  public.merge_request(uuid, uuid),
  public.unmerge_request(uuid),
  public.link_request_clinic(uuid, uuid, uuid),
  public.set_external_ref(uuid, text, text),
  public.export_requests(jsonb),
  public.admin_list_staff(),
  public.admin_upsert_staff(text, text, public.app_role, boolean),
  public.admin_upsert_clinic(uuid, text, boolean),
  public.admin_add_unit(uuid, text)
to authenticated;

-- Pede ao PostgREST (API do Supabase) para reler o schema, caso não tenha feito sozinho.
notify pgrst, 'reload schema';
