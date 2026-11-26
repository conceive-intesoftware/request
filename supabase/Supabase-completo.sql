-- ═══════════════════════════════════════════════════════════════════════════
-- SUPABASE-COMPLETO — um único arquivo para todo o lado Supabase (banco) do Conceive.
-- Cole TUDO no SQL Editor e clique em Run. Pode rodar de novo quantas vezes quiser (atualiza sem apagar dados).
--
--   PARTE A  Banco inteiro: tabelas, permissões (RBAC), auditoria, RLS, funções (RPC), Storage, MFA, SLA, métricas…
--   PARTE B  Tudo o que era opcional ou manual, agora como chaves no começo da Parte B (tudo vem DESLIGADO/vazio):
--            primeiro administrador, clínicas iniciais, e-mails automáticos (ligar/desligar), prazos do alerta de atraso,
--            limpeza mensal, resumo diário e sincronização do Redmine/Pipefy (agendar/cancelar) e limpeza imediata. Não é preciso mais nenhum outro SQL.
--
-- As Edge Functions (notify, external-task, external-sync, admin-users) são código Deno e não rodam no SQL Editor:
-- publique-as em Edge Functions (veja PASSO_A_PASSO.md, Partes 5 e 6).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────── PARTE A ───────────────────────────────────
-- =====================================================================
-- Conceive Requests — migração inicial para Supabase
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
alter table public.profiles add column if not exists mfa_exempt boolean not null default false;

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

-- Anexo de comentário: a imagem fica no comentário que a enviou (e não nos anexos da solicitação).
alter table public.request_attachments add column if not exists comment_id uuid references public.request_comments(id);
create index if not exists request_attachments_comment_idx on public.request_attachments (comment_id);

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
-- 2b. Evolução do esquema (v2): e-mail, roadmap público, votos, resposta do cliente, pesquisa, importação
-- ---------------------------------------------------------------------
-- pg_net envia os e-mails automáticos (opcional; se não existir, o sistema funciona sem e-mail)
do $$ begin create extension if not exists pg_net;
exception when others then raise notice 'pg_net indisponível: e-mails automáticos ficarão desligados'; end $$;

alter table public.requests add column if not exists requester_email text;
alter table public.requests add column if not exists is_public       boolean not null default false;
alter table public.requests add column if not exists csat_score      smallint;
alter table public.requests add column if not exists csat_comment    text;
alter table public.requests add column if not exists csat_at         timestamptz;
alter table public.requests add column if not exists completed_at    timestamptz;
alter table public.requests add column if not exists origin          text not null default 'FORM';
alter table public.requests add column if not exists import_key      text;
do $$ begin
  alter table public.requests add constraint requests_email_chk
    check (requester_email is null or (length(requester_email) <= 160 and requester_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));
exception when duplicate_object then null; end $$;
do $$ begin alter table public.requests add constraint requests_csat_chk
    check ((csat_score is null or csat_score between 1 and 5) and (csat_comment is null or length(csat_comment) <= 1000));
exception when duplicate_object then null; end $$;
do $$ begin alter table public.requests add constraint requests_origin_chk check (origin in ('FORM', 'IMPORT'));
exception when duplicate_object then null; end $$;
create unique index if not exists requests_import_key_uq on public.requests (import_key) where import_key is not null;
create index if not exists requests_public_idx on public.requests (created_at desc) where is_public and deleted_at is null;
update public.requests set completed_at = updated_at where status = 'CONCLUIDO' and completed_at is null;

alter table public.request_comments alter column author_id drop not null;
alter table public.request_comments add column if not exists author_kind text not null default 'STAFF';
alter table public.request_comments alter column created_at set default clock_timestamp();   -- ordem estável mesmo dentro de uma transação
do $$ begin
  alter table public.request_comments add constraint request_comments_author_chk
    check ((author_kind = 'STAFF' and author_id is not null)
        or (author_kind = 'CLIENT' and author_id is null and not is_internal));
exception when duplicate_object then null; end $$;

create table if not exists public.request_votes (
  request_id  uuid not null references public.requests(id),
  user_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (request_id, user_id)
);
create index if not exists request_votes_user_idx on public.request_votes (user_id, created_at desc);

-- configurações internas (URL e segredo do webhook de e-mail). Nunca exposta pela API.
create table if not exists private.app_settings (key text primary key, value text not null);

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

insert into public.role_permissions (role, permission) values
  ('ADMIN','request:publish'), ('PO','request:publish'),
  ('ADMIN','request:edit'), ('PO','request:edit'),
  ('ADMIN','metrics:read'), ('PO','metrics:read'), ('SUPPORT','metrics:read'),
  ('ADMIN','import:run')
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
-- Política de MFA: exigido para toda a equipe por padrão. O Admin pode desligar para todos (app_settings.mfa_required = 'false')
-- ou dispensar uma pessoa (profiles.mfa_exempt). Sem MFA exigido, a sessão com senha (aal1) já vale como equipe.
create or replace function private.mfa_required_for(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value from private.app_settings s where s.key = 'mfa_required'), 'true') <> 'false'
     and not coalesce((select p.mfa_exempt from public.profiles p where p.id = p_uid), false)
$$;

create or replace function private.staff_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.active
    and (coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2' or not private.mfa_required_for(p.id))
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

create or replace function private.mask_email(p text)
returns text language sql immutable set search_path = '' as $$
  select case when p is null then null else left(split_part(p, '@', 1), 1) || '***@' || split_part(p, '@', 2) end
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
    if new.status = 'CONCLUIDO' and new.completed_at is null then new.completed_at := now(); end if;
  else
    new.protocol := old.protocol;                 -- nunca mudam
    new.tracking_token := old.tracking_token;
    new.created_at := old.created_at;
    new.origin := old.origin;
    new.import_key := old.import_key;
    new.updated_at := now();
    if new.status = 'CONCLUIDO' and old.status <> 'CONCLUIDO' then new.completed_at := now();
    elsif new.status <> 'CONCLUIDO' then new.completed_at := null; end if;
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

-- 5.5 e-mails automáticos (via pg_net -> Edge Function "notify"). Silencioso se não configurado.
-- Registro das tentativas de e-mail (sem o texto nem o endereço): permite achar falhas que antes eram silenciosas.
create table if not exists private.notify_log (
  id         bigserial primary key,
  created_at timestamptz not null default clock_timestamp(),
  event      text not null,
  protocol   text,
  outcome    text not null check (outcome in ('ENFILEIRADO', 'ERRO')),
  net_id     bigint,
  detail     text
);
create index if not exists notify_log_created_idx on private.notify_log (created_at desc);

create or replace function private.notify_event(p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_id bigint;
begin
  select s.value into v_url    from private.app_settings s where s.key = 'notify_url';
  select s.value into v_secret from private.app_settings s where s.key = 'notify_secret';
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then return; end if;
  begin
    -- event_id identifica o evento: a função usa como Idempotency-Key no Resend (nova tentativa não duplica o e-mail)
    v_id := net.http_post(url := v_url,
      body := case when p_payload ? 'event_id' then p_payload else p_payload || jsonb_build_object('event_id', gen_random_uuid()) end,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret));
    insert into private.notify_log (event, protocol, outcome, net_id)
    values (coalesce(p_payload ->> 'event', '?'), p_payload ->> 'protocol', 'ENFILEIRADO', v_id);
  exception when others then
    -- e-mail jamais pode impedir o envio ou a atualização de uma solicitação
    begin
      insert into private.notify_log (event, protocol, outcome, detail)
      values (coalesce(p_payload ->> 'event', '?'), p_payload ->> 'protocol', 'ERRO', left(sqlerrm, 300));
    exception when others then null;
    end;
  end;
end $$;

create or replace function private.trg_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r public.requests; v jsonb;
begin
  if tg_table_name = 'requests' then
    if new.origin <> 'FORM' then return new; end if;
    if tg_op = 'INSERT' then
      v := jsonb_build_object('event', 'request_created', 'request_id', new.id, 'protocol', new.protocol, 'title', new.title,
             'module', new.module, 'type', new.type,
             'clinic_name', coalesce((select c.name from public.clinics c where c.id = new.clinic_id), new.pending_clinic_name),
             'client_email', new.requester_email, 'tracking_token', new.tracking_token,
             'requester_name', new.requester_name, 'created_at', new.created_at);
    elsif new.status is distinct from old.status and new.status <> 'ARQUIVADO' and new.requester_email is not null then
      v := jsonb_build_object('event', 'status_changed', 'protocol', new.protocol, 'title', new.title,
             'status', new.status, 'previous_status', old.status,
             'client_email', new.requester_email, 'tracking_token', new.tracking_token);
    else
      return new;
    end if;
  else
    select * into r from public.requests where id = new.request_id;
    if new.author_kind = 'CLIENT' then
      v := jsonb_build_object('event', 'client_reply', 'request_id', r.id, 'protocol', r.protocol, 'title', r.title, 'body', new.body);
    elsif not new.is_internal and r.requester_email is not null then
      v := jsonb_build_object('event', 'comment_public', 'protocol', r.protocol, 'title', r.title, 'body', new.body,
             'client_email', r.requester_email, 'tracking_token', r.tracking_token);
    else
      return new;
    end if;
  end if;
  perform private.notify_event(v);
  return new;
end $$;
drop trigger if exists trg_notify_ins on public.requests;
create trigger trg_notify_ins after insert on public.requests for each row execute function private.trg_notify();
drop trigger if exists trg_notify_upd on public.requests;
create trigger trg_notify_upd after update of status on public.requests for each row execute function private.trg_notify();
drop trigger if exists trg_notify_cmt on public.request_comments;
create trigger trg_notify_cmt after insert on public.request_comments for each row execute function private.trg_notify();

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
alter table public.request_votes      enable row level security;
alter table private.app_settings      enable row level security;
alter table private.notify_log        enable row level security;

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
values ('attachments', 'attachments', false, 52428800,
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

drop function if exists public.submit_request(uuid, uuid, text, text, public.requester_role, text, public.system_module, public.request_type, text, text, text[]);
create or replace function public.submit_request(
  p_clinic_id uuid, p_unit_id uuid, p_pending_clinic_name text,
  p_requester_name text, p_requester_role public.requester_role, p_whatsapp text,
  p_module public.system_module, p_type public.request_type,
  p_title text, p_description text,
  p_attachment_paths text[] default '{}',
  p_requester_email text default null)
returns table (protocol text, tracking_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_phone text; v_clinic uuid := p_clinic_id; v_unit uuid := p_unit_id; v_pending text;
  v_req public.requests; v_path text; v_obj record; v_email text;
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
  v_email := nullif(lower(trim(coalesce(p_requester_email, ''))), '');
  if v_email is null then raise exception 'email_required'; end if;
  if (length(v_email) > 160 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'invalid_email'; end if;

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
                               whatsapp_e164, requester_email, title, description, module, type, submitted_by)
  values (v_clinic, v_unit, v_pending, trim(p_requester_name), p_requester_role,
          v_phone, v_email, trim(p_title), trim(p_description), p_module, p_type, v_uid)
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
    'has_email', r.requester_email is not null,
    'csat_score', r.csat_score, 'csat_comment', r.csat_comment,
    'comments', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'created_at', c.created_at,
                                                              'from_client', c.author_kind = 'CLIENT')
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
    'mfa_required', private.mfa_required_for((select auth.uid())),
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
-- ───────── SLA: solicitações sem resposta ou paradas ─────────
-- Prazos em dias corridos, ajustáveis em private.app_settings: sla_first_days (padrão 3) e sla_idle_days (padrão 15).
--   SEM_RESPOSTA: "Recebido" sem resposta pública da equipe, ou cliente respondeu e a equipe não voltou, além do prazo.
--   PARADA: "Em análise" ou "Em desenvolvimento" sem nenhuma movimentação (status ou comentário da equipe) além do prazo.
-- Não avalia: concluídas, arquivadas, mescladas e importadas da planilha antiga.
create or replace function private.sla_state(r public.requests)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_first int := coalesce((select nullif(s.value, '')::int from private.app_settings s where s.key = 'sla_first_days'), 3);
  v_idle  int := coalesce((select nullif(s.value, '')::int from private.app_settings s where s.key = 'sla_idle_days'), 15);
  v_last_kind text; v_last_at timestamptz; v_staff_touch timestamptz; v_staff_public boolean;
begin
  if r.deleted_at is not null or r.merged_into_id is not null or r.origin = 'IMPORT'
     or r.status in ('CONCLUIDO', 'ARQUIVADO') then
    return null;
  end if;
  select c.author_kind, c.created_at into v_last_kind, v_last_at
    from public.request_comments c where c.request_id = r.id and not c.is_internal
    order by c.created_at desc, c.id desc limit 1;
  if v_last_kind = 'CLIENT' and v_last_at < now() - make_interval(days => v_first) then return 'SEM_RESPOSTA'; end if;
  if r.status = 'RECEBIDO' then
    select exists (select 1 from public.request_comments c where c.request_id = r.id and c.author_kind = 'STAFF' and not c.is_internal)
      into v_staff_public;
    if not v_staff_public and r.created_at < now() - make_interval(days => v_first) then return 'SEM_RESPOSTA'; end if;
  elsif r.status in ('EM_ANALISE_PRODUTO', 'EM_DESENVOLVIMENTO') then
    select max(c.created_at) into v_staff_touch from public.request_comments c where c.request_id = r.id and c.author_kind = 'STAFF';
    if greatest(r.updated_at, coalesce(v_staff_touch, r.updated_at)) < now() - make_interval(days => v_idle) then return 'PARADA'; end if;
  end if;
  return null;
end $$;

-- Resumo para a equipe (chamado pelo agendamento diário; só envia se houver algo a tratar).
create or replace function private.send_sla_digest()
returns int language plpgsql security definer set search_path = '' as $$
declare v_items jsonb; v_n int;
begin
  select count(*), coalesce(jsonb_agg(jsonb_build_object('protocol', x.protocol, 'title', left(x.title, 120), 'sla', x.sla,
                      'days', x.days) order by x.created_at) filter (where x.rn <= 30), '[]'::jsonb)
    into v_n, v_items
  from (select r.protocol, r.title, r.created_at, private.sla_state(r) as sla,
               extract(day from now() - r.created_at)::int as days,
               row_number() over (order by r.created_at) as rn
        from public.requests r where r.deleted_at is null) x
  where x.sla is not null;
  if v_n > 0 then
    perform private.notify_event(jsonb_build_object('event', 'sla_digest', 'protocol', 'RESUMO',
      'title', v_n || case when v_n = 1 then ' solicitação precisa' else ' solicitações precisam' end || ' de atenção',
      'count', v_n, 'items', v_items));
  end if;
  return v_n;
end $$;

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
  v_sla boolean := coalesce(f ->> 'sla', '') = 'stalled';
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
      and (not v_sla or private.sla_state(r) is not null)
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
        'is_public', r.is_public, 'csat_score', r.csat_score, 'sla', private.sla_state(r),
        'votes', (select count(*) from public.request_votes v where v.request_id = r.id),
        'awaiting_reply', coalesce((select c.author_kind = 'CLIENT' from public.request_comments c
                                     where c.request_id = r.id and not c.is_internal order by c.created_at desc, c.id desc limit 1), false),
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
      jsonb_build_object('fields', jsonb_build_array('requester_name', 'whatsapp_e164', 'requester_email')));
  end if;

  if private.can('audit:read') then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', a.id, 'action', a.action, 'entity', a.entity, 'created_at', a.created_at,
        'ip', a.ip_address, 'user_agent', a.user_agent,
        'user', coalesce(p.name || ' (' || p.role::text || ')', 'Cliente / sistema'),
        'previous', case when v_pii then a.previous_value else a.previous_value - 'requester_name' - 'whatsapp_e164' - 'requester_email' end,
        'next', case when v_pii then a.new_value else a.new_value - 'requester_name' - 'whatsapp_e164' - 'requester_email' end)
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
    'requester_email', case when v_pii then r.requester_email else private.mask_email(r.requester_email) end,
    'pii_masked', not v_pii,
    'is_public', r.is_public, 'origin', r.origin,
    'votes', (select count(*) from public.request_votes v where v.request_id = r.id),
    'csat', jsonb_build_object('score', r.csat_score, 'comment', r.csat_comment, 'at', r.csat_at),
    'completed_at', r.completed_at,
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
                    from public.request_attachments a where a.request_id = r.id and a.comment_id is null),
    'comments', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'is_internal', c.is_internal,
                        'created_at', c.created_at, 'author_name', p.name, 'author_role', p.role, 'author_kind', c.author_kind,
                        'attachments', (select coalesce(jsonb_agg(jsonb_build_object('id', ca.id, 'file_name', ca.file_name,
                            'mime_type', ca.mime_type, 'size_bytes', ca.size_bytes, 'storage_path', ca.storage_path)
                            order by ca.created_at), '[]'::jsonb) from public.request_attachments ca where ca.comment_id = c.id))
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

drop function if exists public.add_comment(uuid, text, boolean);
create or replace function public.add_comment(p_request_id uuid, p_body text, p_internal boolean, p_attachment_paths text[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := (select auth.uid()); v_path text; v_obj record;
begin
  perform private.require(case when coalesce(p_internal, true) then 'comment:internal' else 'comment:public' end);
  if length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_comment'; end if;
  if not exists (select 1 from public.requests where id = p_request_id and deleted_at is null) then raise exception 'not_found'; end if;
  if coalesce(array_length(p_attachment_paths, 1), 0) > 5 then raise exception 'too_many_attachments'; end if;
  insert into public.request_comments (request_id, author_id, body, is_internal)
  values (p_request_id, v_uid, trim(p_body), coalesce(p_internal, true))
  returning id into v_id;

  foreach v_path in array coalesce(p_attachment_paths, '{}') loop
    if v_path not like v_uid::text || '/%' then raise exception 'invalid_attachment'; end if;
    if exists (select 1 from public.request_attachments a where a.storage_path = v_path) then raise exception 'invalid_attachment'; end if;
    select o.name, o.metadata into v_obj from storage.objects o where o.bucket_id = 'attachments' and o.name = v_path;
    if not found then raise exception 'invalid_attachment'; end if;
    insert into public.request_attachments (request_id, comment_id, file_name, mime_type, size_bytes, storage_path)
    values (p_request_id, v_id,
            left(case when position('__' in v_path) > 0 then substr(v_path, position('__' in v_path) + 2) else v_path end, 120),
            coalesce(v_obj.metadata ->> 'mimetype', 'application/octet-stream'),
            coalesce((v_obj.metadata ->> 'size')::bigint, 0), v_path);
  end loop;
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
-- 9b. Roadmap público, votos, resposta do cliente, pesquisa, métricas, importação (v2)
-- ---------------------------------------------------------------------
create or replace function public.set_request_public(p_id uuid, p_public boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('request:publish');
  if coalesce(p_public, false) and exists (select 1 from public.requests where id = p_id and merged_into_id is not null) then
    raise exception 'invalid_publish';
  end if;
  update public.requests set is_public = coalesce(p_public, false) where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
end $$;

-- Lista pública (sem login): só o que a equipe publicou; nada de dados pessoais.
create or replace function public.list_public_requests(
  p_search text default null, p_module public.system_module default null, p_page int default 1)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_pat text; v_total bigint; v_rows jsonb;
  v_page int := greatest(coalesce(p_page, 1), 1);
begin
  if nullif(trim(p_search), '') is not null then
    v_pat := '%' || replace(replace(replace(trim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  select count(*) into v_total from public.requests r
   where r.is_public and r.deleted_at is null and r.merged_into_id is null
     and (p_module is null or r.module = p_module)
     and (v_pat is null or r.title ilike v_pat or r.description ilike v_pat);
  select coalesce(jsonb_agg(x.j order by x.votes desc, x.created_at desc), '[]'::jsonb) into v_rows from (
    select r.created_at, (select count(*) from public.request_votes v where v.request_id = r.id) as votes,
      jsonb_build_object(
        'id', r.id, 'protocol', r.protocol, 'title', r.title, 'excerpt', left(r.description, 280),
        'module', r.module, 'type', r.type, 'status', r.status, 'created_at', r.created_at,
        'votes', (select count(*) from public.request_votes v where v.request_id = r.id),
        'voted_by_me', v_uid is not null and exists (select 1 from public.request_votes v where v.request_id = r.id and v.user_id = v_uid),
        'mine', v_uid is not null and r.submitted_by = v_uid) as j
    from public.requests r
    where r.is_public and r.deleted_at is null and r.merged_into_id is null
      and (p_module is null or r.module = p_module)
      and (v_pat is null or r.title ilike v_pat or r.description ilike v_pat)
    order by (select count(*) from public.request_votes v where v.request_id = r.id) desc, r.created_at desc
    offset (v_page - 1) * 20 limit 20
  ) x;
  return jsonb_build_object('total', v_total, 'page', v_page, 'page_size', 20, 'rows', v_rows);
end $$;

create or replace function public.vote_request(p_request_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); r public.requests; v_n int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into r from public.requests where id = p_request_id and is_public and deleted_at is null and merged_into_id is null;
  if not found then raise exception 'not_found'; end if;
  if r.submitted_by = v_uid then raise exception 'invalid_vote'; end if;     -- o próprio pedido já conta
  if (select count(*) from public.request_votes v where v.user_id = v_uid and v.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.request_votes (request_id, user_id) values (r.id, v_uid) on conflict do nothing;
  select count(*) into v_n from public.request_votes v where v.request_id = r.id;
  return v_n;
end $$;

create or replace function public.unvote_request(p_request_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_n int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  delete from public.request_votes where request_id = p_request_id and user_id = v_uid;
  select count(*) into v_n from public.request_votes v where v.request_id = p_request_id;
  return v_n;
end $$;

-- Resposta do cliente na página de acompanhamento (precisa do token E de uma sessão anônima validada pelo CAPTCHA).
create or replace function public.add_client_comment(p_token text, p_body text, p_attachment_paths text[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); r public.requests; v_id uuid; v_path text; v_obj record;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then raise exception 'not_found'; end if;
  select * into r from public.requests where tracking_token = p_token;
  if not found then raise exception 'not_found'; end if;
  if r.deleted_at is not null then raise exception 'closed_request'; end if;
  if length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_comment'; end if;
  if coalesce(array_length(p_attachment_paths, 1), 0) > 5 then raise exception 'too_many_attachments'; end if;
  if (select count(*) from public.request_comments c where c.request_id = r.id and c.author_kind = 'CLIENT' and c.created_at > now() - interval '10 minutes') >= 5
     or (select count(*) from public.request_comments c where c.request_id = r.id and c.author_kind = 'CLIENT') >= 60 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  insert into public.request_comments (request_id, author_id, author_kind, body, is_internal)
  values (r.id, null, 'CLIENT', trim(p_body), false) returning id into v_id;

  foreach v_path in array coalesce(p_attachment_paths, '{}') loop
    if v_path not like v_uid::text || '/%' then raise exception 'invalid_attachment'; end if;
    if exists (select 1 from public.request_attachments a where a.storage_path = v_path) then raise exception 'invalid_attachment'; end if;
    select o.name, o.metadata into v_obj from storage.objects o where o.bucket_id = 'attachments' and o.name = v_path;
    if not found then raise exception 'invalid_attachment'; end if;
    insert into public.request_attachments (request_id, comment_id, file_name, mime_type, size_bytes, storage_path)
    values (r.id, v_id,
            left(case when position('__' in v_path) > 0 then substr(v_path, position('__' in v_path) + 2) else v_path end, 120),
            coalesce(v_obj.metadata ->> 'mimetype', 'application/octet-stream'),
            coalesce((v_obj.metadata ->> 'size')::bigint, 0), v_path);
  end loop;
  return v_id;
end $$;

-- Pesquisa de satisfação (nota 1 a 5) — só depois de concluída; quem tem o token pode (re)avaliar.
create or replace function public.rate_request(p_token text, p_score int, p_comment text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.requests;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then raise exception 'not_found'; end if;
  select * into r from public.requests where tracking_token = p_token and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'CONCLUIDO' then raise exception 'not_rateable'; end if;
  if p_score is null or p_score not between 1 and 5 then raise exception 'invalid_score'; end if;
  if length(coalesce(p_comment, '')) > 1000 then raise exception 'invalid_comment'; end if;
  update public.requests set csat_score = p_score, csat_comment = nullif(trim(p_comment), ''), csat_at = now() where id = r.id;
end $$;

-- Métricas (sem dados pessoais). p_days = 0 -> todo o período.
create or replace function public.get_metrics(p_days int default 90)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_since timestamptz := case when coalesce(p_days, 0) > 0 then now() - make_interval(days => p_days) else '-infinity'::timestamptz end;
  v_wk0 date := (date_trunc('week', now() at time zone 'America/Fortaleza'))::date;
  v_out jsonb;
begin
  perform private.require('metrics:read');
  with base as (
    select r.* from public.requests r where r.deleted_at is null and r.created_at >= v_since
  ), first_resp as (
    select b.id, extract(epoch from (min(c.created_at) - b.created_at)) / 3600.0 as hrs
    from base b join public.request_comments c on c.request_id = b.id and c.author_kind = 'STAFF' and not c.is_internal
    where b.origin = 'FORM' group by b.id, b.created_at
  )
  select jsonb_build_object(
    'days', coalesce(p_days, 0),
    'total', (select count(*) from base),
    'open', (select count(*) from base where status <> 'CONCLUIDO'),
    'completed', (select count(*) from base where status = 'CONCLUIDO'),
    'completion_rate', (select round(100.0 * count(*) filter (where status = 'CONCLUIDO') / nullif(count(*), 0), 1) from base),
    'awaiting_reply', (select count(*) from base b where coalesce((select c.author_kind = 'CLIENT' from public.request_comments c
                         where c.request_id = b.id and not c.is_internal order by c.created_at desc, c.id desc limit 1), false)),
    'stalled', (select count(*) from base b join public.requests rr on rr.id = b.id where private.sla_state(rr) is not null),
    'avg_first_response_hours', (select round(avg(hrs)::numeric, 1) from first_resp),
    'avg_resolution_days', (select round((avg(extract(epoch from (completed_at - created_at))) / 86400.0)::numeric, 1)
                            from base where status = 'CONCLUIDO' and origin = 'FORM' and completed_at is not null),
    'by_status', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc), '[]'::jsonb)
                  from (select status::text k, count(*) n from base group by 1) s),
    'by_module', (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc), '[]'::jsonb)
                  from (select module::text k, count(*) n from base group by 1) s),
    'by_type',   (select coalesce(jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc), '[]'::jsonb)
                  from (select type::text k, count(*) n from base group by 1) s),
    'top_clinics', (select coalesce(jsonb_agg(jsonb_build_object('name', k, 'count', n) order by n desc, k), '[]'::jsonb)
                    from (select coalesce(c.name, b.pending_clinic_name, '—') k, count(*) n
                          from base b left join public.clinics c on c.id = b.clinic_id group by 1 order by 2 desc, 1 limit 10) s),
    'weekly', (select jsonb_agg(jsonb_build_object('week', w.d, 'created', (select count(*) from public.requests r
                 where r.deleted_at is null and (r.created_at at time zone 'America/Fortaleza')::date >= w.d
                   and (r.created_at at time zone 'America/Fortaleza')::date < w.d + 7),
               'completed', (select count(*) from public.requests r where r.deleted_at is null and r.completed_at is not null
                 and (r.completed_at at time zone 'America/Fortaleza')::date >= w.d
                 and (r.completed_at at time zone 'America/Fortaleza')::date < w.d + 7)) order by w.d)
               from (select (v_wk0 - (i * 7))::date as d from generate_series(11, 0, -1) i) w),
    'csat', jsonb_build_object(
      'count', (select count(*) from base where csat_score is not null),
      'avg', (select round(avg(csat_score)::numeric, 2) from base where csat_score is not null),
      'distribution', (select jsonb_agg(jsonb_build_object('score', g, 'count', (select count(*) from base where csat_score = g)) order by g)
                       from generate_series(1, 5) g)),
    'votes_total', (select count(*) from public.request_votes v join base b on b.id = v.request_id),
    'top_voted', (select coalesce(jsonb_agg(jsonb_build_object('protocol', t.protocol, 'title', t.title, 'votes', t.n) order by t.n desc), '[]'::jsonb)
                  from (select b.protocol, b.title, count(*) n from base b join public.request_votes v on v.request_id = b.id
                        group by b.id, b.protocol, b.title order by 3 desc limit 5) t)
  ) into v_out;
  return v_out;
end $$;

-- Importação da planilha antiga (lotes de até 200 linhas). Repetir o mesmo lote não duplica (import_key).
create or replace function public.admin_import_requests(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb; v_idx int; v_ins int := 0; v_skip int := 0; v_errs jsonb := '[]'::jsonb; v_n int;
  v_key text; v_name text; v_title text; v_desc text; v_clinic uuid; v_unit uuid; v_pending text; v_cname text;
  v_phone text; v_bad_phone boolean; v_email text; v_created timestamptz; v_status public.request_status;
  v_id uuid;
begin
  perform private.require('import:run');
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_input'; end if;
  if jsonb_array_length(p_rows) > 200 then raise exception 'too_many_rows'; end if;

  for v_row, v_idx in select e, (o - 1)::int from jsonb_array_elements(p_rows) with ordinality as t(e, o) loop
    begin
      v_key := nullif(trim(v_row ->> 'key'), '');
      v_name := trim(coalesce(v_row ->> 'name', ''));
      v_title := trim(coalesce(v_row ->> 'title', ''));
      v_desc := left(trim(coalesce(v_row ->> 'description', '')), 8000);
      if length(v_name) not between 3 and 120 then raise exception 'invalid_name'; end if;
      if length(v_title) not between 5 and 140 then raise exception 'invalid_title'; end if;
      if length(v_desc) < 20 then raise exception 'invalid_description'; end if;

      v_cname := trim(coalesce(v_row ->> 'clinic', ''));
      v_clinic := null; v_unit := null; v_pending := null;
      if v_cname <> '' then
        select c.id into v_clinic from public.clinics c where private.norm(c.name) = private.norm(v_cname) limit 1;
        if v_clinic is null then
          if length(v_cname) < 3 then raise exception 'clinic_required'; end if;
          v_pending := left(v_cname, 160);
        elsif nullif(trim(v_row ->> 'unit'), '') is not null then
          select u.id into v_unit from public.clinic_units u
           where u.clinic_id = v_clinic and private.norm(u.name) = private.norm(trim(v_row ->> 'unit')) limit 1;
        end if;
      else
        raise exception 'clinic_required';
      end if;

      v_phone := private.normalize_br_phone(v_row ->> 'whatsapp');
      v_bad_phone := v_phone is null;
      if v_bad_phone then v_phone := '+5500000000000'; end if;     -- marcador: telefone ausente/ inválido na planilha
      v_email := nullif(lower(trim(coalesce(v_row ->> 'email', ''))), '');
      if v_email is not null and (length(v_email) > 160 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then v_email := null; end if;
      v_created := least(coalesce(nullif(v_row ->> 'created_at', '')::timestamptz, now()), now());
      v_status := coalesce(nullif(v_row ->> 'status', '')::public.request_status, 'RECEBIDO');
      if v_status = 'ARQUIVADO' then v_status := 'CONCLUIDO'; end if;

      insert into public.requests (clinic_id, unit_id, pending_clinic_name, requester_name, requester_role, whatsapp_e164,
                                   requester_email, title, description, module, type, status, created_at, origin, import_key)
      values (v_clinic, v_unit, v_pending, v_name, coalesce(nullif(v_row ->> 'role', ''), 'OUTRO')::public.requester_role, v_phone,
              v_email, v_title, v_desc, coalesce(nullif(v_row ->> 'module', ''), 'OUTRO')::public.system_module,
              coalesce(nullif(v_row ->> 'type', ''), 'NOVA_FUNCIONALIDADE')::public.request_type,
              v_status, v_created, 'IMPORT', v_key)
      on conflict (import_key) where import_key is not null do nothing
      returning id into v_id;
      get diagnostics v_n = row_count;
      if v_n = 0 then
        v_skip := v_skip + 1;
      else
        v_ins := v_ins + 1;
        if v_bad_phone then
          insert into public.tags (name) values ('telefone-invalido') on conflict (name) do nothing;
          insert into public.request_tags (request_id, tag_id) select v_id, t.id from public.tags t where t.name = 'telefone-invalido';
        end if;
      end if;
    exception when others then
      v_skip := v_skip + 1;
      if jsonb_array_length(v_errs) < 50 then
        v_errs := v_errs || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', left(sqlerrm, 120)));
      end if;
    end;
  end loop;
  perform private.write_audit('CREATE', 'import_batch', null, null,
    jsonb_build_object('inserted', v_ins, 'skipped', v_skip));
  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip, 'errors', v_errs);
end $$;

-- ---------------------------------------------------------------------
-- 10. RPCs de administração
-- ---------------------------------------------------------------------
create or replace function public.admin_list_staff()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('user:manage');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'name', p.name,
                          'role', p.role, 'active', p.active, 'mfa_exempt', p.mfa_exempt,
                          'mfa_enrolled', exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
                          'last_sign_in_at', (select u.last_sign_in_at from auth.users u where u.id = p.id))
                          order by p.name), '[]'::jsonb) from public.profiles p);
end $$;

-- Política de MFA (Admin): liga/desliga para toda a equipe, dispensa uma pessoa e apaga o autenticador de alguém que perdeu o celular.
create or replace function public.admin_get_security()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('user:manage');
  return jsonb_build_object('mfa_required',
    coalesce((select s.value from private.app_settings s where s.key = 'mfa_required'), 'true') <> 'false');
end $$;

create or replace function public.admin_set_mfa_required(p_required boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  perform private.require('user:manage');
  if p_required is null then raise exception 'invalid_input'; end if;
  select s.value into v_old from private.app_settings s where s.key = 'mfa_required';
  insert into private.app_settings (key, value) values ('mfa_required', case when p_required then 'true' else 'false' end)
    on conflict (key) do update set value = excluded.value;
  perform private.write_audit('UPDATE', 'settings', 'mfa_required',
    jsonb_build_object('mfa_required', coalesce(v_old, 'true') <> 'false'), jsonb_build_object('mfa_required', p_required));
end $$;

create or replace function public.admin_set_user_mfa(p_user uuid, p_exempt boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('user:manage');
  update public.profiles set mfa_exempt = coalesce(p_exempt, false) where id = p_user;
  if not found then raise exception 'user_not_found'; end if;
end $$;

create or replace function public.admin_reset_mfa(p_user uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform private.require('user:manage');
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'user_not_found'; end if;
  delete from auth.mfa_factors where user_id = p_user;
  get diagnostics v_n = row_count;
  perform private.write_audit('UPDATE', 'profiles', p_user::text,
    jsonb_build_object('mfa_factors', v_n), jsonb_build_object('mfa_factors', 0, 'acao', 'autenticador redefinido'));
  return v_n;
end $$;

-- Edição dos dados de uma solicitação pela equipe (a trilha de auditoria guarda antes/depois). Só os campos enviados mudam.
create or replace function public.update_request_fields(p_id uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb); r public.requests;
  v_title text; v_desc text; v_name text; v_phone text; v_email text; v_role public.requester_role;
  v_module public.system_module; v_type public.request_type;
begin
  perform private.require('request:edit');
  if jsonb_typeof(f) <> 'object' then raise exception 'invalid_input'; end if;
  select * into r from public.requests where id = p_id and deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  v_title  := case when f ? 'title' then trim(f ->> 'title') else r.title end;
  v_desc   := case when f ? 'description' then trim(f ->> 'description') else r.description end;
  v_name   := case when f ? 'requester_name' then trim(f ->> 'requester_name') else r.requester_name end;
  v_role   := case when f ? 'requester_role' then (f ->> 'requester_role')::public.requester_role else r.requester_role end;
  v_module := case when f ? 'module' then (f ->> 'module')::public.system_module else r.module end;
  v_type   := case when f ? 'type' then (f ->> 'type')::public.request_type else r.type end;
  if length(coalesce(v_title, '')) not between 5 and 140 then raise exception 'invalid_title'; end if;
  if length(coalesce(v_desc, '')) not between 20 and 8000 then raise exception 'invalid_description'; end if;
  if length(coalesce(v_name, '')) not between 3 and 120 then raise exception 'invalid_name'; end if;
  if f ? 'whatsapp' then
    if not private.can('pii:view') then raise exception 'forbidden: pii:view'; end if;
    v_phone := private.normalize_br_phone(f ->> 'whatsapp');
    if v_phone is null then raise exception 'invalid_phone'; end if;
  else v_phone := r.whatsapp_e164; end if;
  if f ? 'requester_email' then
    if not private.can('pii:view') then raise exception 'forbidden: pii:view'; end if;
    v_email := nullif(lower(trim(coalesce(f ->> 'requester_email', ''))), '');
    if v_email is not null and (length(v_email) > 160 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'invalid_email'; end if;
  else v_email := r.requester_email; end if;
  if (f ? 'requester_name') and not private.can('pii:view') then raise exception 'forbidden: pii:view'; end if;
  update public.requests
     set title = v_title, description = v_desc, requester_name = v_name, requester_role = v_role,
         module = v_module, type = v_type, whatsapp_e164 = v_phone, requester_email = v_email
   where id = p_id;
end $$;

-- Unidades: renomear e remover (só se nenhuma solicitação usa a unidade).
create or replace function public.admin_rename_unit(p_unit_id uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('clinic:manage');
  if length(trim(coalesce(p_name, ''))) not between 1 and 160 then raise exception 'invalid_input'; end if;
  update public.clinic_units set name = trim(p_name) where id = p_unit_id;
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.admin_delete_unit(p_unit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('clinic:manage');
  if exists (select 1 from public.requests where unit_id = p_unit_id) then raise exception 'unit_in_use'; end if;
  delete from public.clinic_units where id = p_unit_id;
  if not found then raise exception 'not_found'; end if;
end $$;

-- Últimas tentativas de e-mail e o resultado HTTP da Edge Function (lido do pg_net quando disponível).
create or replace function public.admin_notify_log(p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require('user:manage');
  if to_regclass('net._http_response') is not null then
    execute $q$
      select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) from (
        select l.id, l.created_at, l.event, l.protocol, l.outcome, l.detail,
               r.status_code as http_status, left(r.error_msg, 200) as http_error, left(r.content::text, 400) as http_body
        from private.notify_log l left join net._http_response r on r.id = l.net_id
        order by l.id desc limit $1) x $q$ into v using least(greatest(coalesce(p_limit, 50), 1), 200);
  else
    select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) into v from (
      select l.id, l.created_at, l.event, l.protocol, l.outcome, l.detail, null::int as http_status, null::text as http_error, null::text as http_body
      from private.notify_log l order by l.id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) x;
  end if;
  return v;
end $$;

-- Situação da ligação com o e-mail (o painel mostra um "checklist"; nunca devolve o segredo).
create or replace function public.admin_notify_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  perform private.require('user:manage');
  select s.value into v_url    from private.app_settings s where s.key = 'notify_url';
  select s.value into v_secret from private.app_settings s where s.key = 'notify_secret';
  return jsonb_build_object(
    'pg_net',     to_regclass('net._http_response') is not null,
    'url_set',    coalesce(v_url, '') <> '',
    'url',        nullif(v_url, ''),
    'secret_set', coalesce(v_secret, '') <> '');
end $$;

-- Botão "Enviar e-mail de teste" do painel: manda um e-mail de teste (para o próprio Admin, ou para p_to) pela mesma
-- rota dos e-mails reais. O resultado aparece em "E-mails automáticos" alguns segundos depois.
create or replace function public.admin_send_test_email(p_to text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_to text; v_url text; v_secret text;
begin
  perform private.require('user:manage');
  select s.value into v_url    from private.app_settings s where s.key = 'notify_url';
  select s.value into v_secret from private.app_settings s where s.key = 'notify_secret';
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then raise exception 'notify_not_configured'; end if;
  v_to := nullif(lower(trim(coalesce(p_to, (select p.email from public.profiles p where p.id = (select auth.uid()))))), '');
  if v_to is null or length(v_to) > 160 or v_to !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid_email'; end if;
  perform private.notify_event(jsonb_build_object('event', 'test', 'protocol', 'TESTE',
            'title', 'Teste de e-mail do Conceive', 'test_to', v_to));
  return jsonb_build_object('to', v_to);
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
  public.submit_request(uuid, uuid, text, text, public.requester_role, text, public.system_module, public.request_type, text, text, text[], text),
  public.my_context(),
  public.log_login(),
  public.list_requests(jsonb, int, int),
  public.get_request_detail(uuid),
  public.set_request_status(uuid, public.request_status),
  public.set_request_priority(uuid, public.priority_level, int, numeric, numeric, numeric),
  public.set_request_tags(uuid, text[]),
  public.add_comment(uuid, text, boolean, text[]),
  public.archive_request(uuid),
  public.merge_request(uuid, uuid),
  public.unmerge_request(uuid),
  public.link_request_clinic(uuid, uuid, uuid),
  public.set_external_ref(uuid, text, text),
  public.export_requests(jsonb),
  public.admin_list_staff(),
  public.admin_get_security(),
  public.admin_set_mfa_required(boolean),
  public.admin_set_user_mfa(uuid, boolean),
  public.admin_reset_mfa(uuid),
  public.update_request_fields(uuid, jsonb),
  public.admin_rename_unit(uuid, text),
  public.admin_delete_unit(uuid),
  public.admin_notify_log(int),
  public.admin_notify_status(),
  public.admin_send_test_email(text),
  public.admin_upsert_staff(text, text, public.app_role, boolean),
  public.admin_upsert_clinic(uuid, text, boolean),
  public.admin_add_unit(uuid, text),
  public.set_request_public(uuid, boolean),
  public.vote_request(uuid),
  public.unvote_request(uuid),
  public.add_client_comment(text, text, text[]),
  public.get_metrics(int),
  public.admin_import_requests(jsonb)
to authenticated;

-- páginas públicas (podem ser chamadas só com a chave pública, sem sessão)
grant execute on function public.list_public_requests(text, public.system_module, int) to anon, authenticated;
grant execute on function public.rate_request(text, int, text) to anon, authenticated;

revoke all on private.app_settings from public, anon, authenticated;
revoke all on private.notify_log from public, anon, authenticated;
revoke all on sequence private.notify_log_id_seq from public, anon, authenticated;

-- ───────── v3.9 · pedidos parecidos (formulário) e status vindo do Redmine/Pipefy ─────────

-- Sugere pedidos JÁ PUBLICADOS no roadmap parecidos com o que a pessoa está digitando (só título, status e apoios:
-- nada de dados pessoais, nada de pedidos não publicados). Compara palavras relevantes (4+ letras, sem acento).
create or replace function public.find_similar_requests(p_title text, p_description text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_words text[]; v_min int; v_rows jsonb;
begin
  if length(trim(coalesce(p_title, ''))) < 8 then return '[]'::jsonb; end if;
  select coalesce(array_agg(x.w order by length(x.w) desc, x.w), '{}') into v_words
  from (select distinct w
        from regexp_split_to_table(private.norm(left(trim(coalesce(p_title, '')) || ' ' || coalesce(p_description, ''), 600)), '[^a-z0-9]+') w
        where length(w) >= 4
          and w <> all (array['para','como','esta','esse','essa','isso','pelo','pela','pelos','pelas','com','sem','sobre','quando',
                              'onde','mais','muito','mesmo','tambem','deve','poder','pode','podem','fazer','forma','gostaria',
                              'preciso','precisamos','seria','sistema','funcionalidade','melhoria','solicitacao','necessario',
                              'permitir','gostariamos','possivel','quero','queremos'])
        limit 40) x;
  v_words := v_words[1:12];
  if coalesce(array_length(v_words, 1), 0) < 2 then return '[]'::jsonb; end if;
  v_min := greatest(2, ceil(array_length(v_words, 1) / 2.0)::int);
  select coalesce(jsonb_agg(t.j order by t.hits desc, t.votes desc), '[]'::jsonb) into v_rows from (
    select s.hits, s.votes,
           jsonb_build_object('id', s.id, 'protocol', s.protocol, 'title', s.title, 'status', s.status, 'module', s.module,
                              'votes', s.votes, 'excerpt', left(s.description, 160)) as j
    from (select r.id, r.protocol, r.title, r.status, r.module, r.description,
                 (select count(*) from public.request_votes v where v.request_id = r.id) as votes,
                 (select count(*) from unnest(v_words) w where position(w in private.norm(r.title || ' ' || r.description)) > 0) as hits
          from public.requests r
          where r.is_public and r.deleted_at is null and r.merged_into_id is null) s
    where s.hits >= v_min
    order by s.hits desc, s.votes desc
    limit 5) t;
  return v_rows;
end $$;

-- Status do Redmine/Pipefy → etapa do Conceive. O nome (em minúsculas e sem acento) é o do status no Redmine ou o da FASE
-- no Pipefy. Edite à vontade (insert/update/delete nesta tabela); status sem linha aqui não mudam nada.
create table if not exists private.external_status_map (
  system          text not null check (system in ('REDMINE', 'PIPEFY')),
  external_status text not null,
  status          public.request_status not null,
  primary key (system, external_status)
);
insert into private.external_status_map (system, external_status, status) values
  ('REDMINE', 'new', 'APROVADO_ROADMAP'), ('REDMINE', 'nova', 'APROVADO_ROADMAP'),
  ('REDMINE', 'in progress', 'EM_DESENVOLVIMENTO'), ('REDMINE', 'em andamento', 'EM_DESENVOLVIMENTO'),
  ('REDMINE', 'em progresso', 'EM_DESENVOLVIMENTO'),
  ('REDMINE', 'resolved', 'CONCLUIDO'), ('REDMINE', 'resolvida', 'CONCLUIDO'),
  ('REDMINE', 'closed', 'CONCLUIDO'), ('REDMINE', 'fechada', 'CONCLUIDO'), ('REDMINE', 'concluida', 'CONCLUIDO'),
  ('PIPEFY', 'backlog', 'APROVADO_ROADMAP'), ('PIPEFY', 'a fazer', 'APROVADO_ROADMAP'), ('PIPEFY', 'to do', 'APROVADO_ROADMAP'),
  ('PIPEFY', 'em desenvolvimento', 'EM_DESENVOLVIMENTO'), ('PIPEFY', 'desenvolvimento', 'EM_DESENVOLVIMENTO'),
  ('PIPEFY', 'doing', 'EM_DESENVOLVIMENTO'),
  ('PIPEFY', 'concluido', 'CONCLUIDO'), ('PIPEFY', 'finalizado', 'CONCLUIDO'), ('PIPEFY', 'done', 'CONCLUIDO'),
  ('PIPEFY', 'publicado', 'CONCLUIDO')
on conflict do nothing;

-- Último status externo visto por solicitação. Fica FORA de public.requests de propósito: atualizar a solicitação a cada
-- verificação mexeria no "updated_at" (e no alerta de pedido parado) e encheria a auditoria.
create table if not exists private.external_sync_state (
  request_id      uuid primary key references public.requests(id),
  external_status text,
  checked_at      timestamptz not null default now()
);
alter table private.external_status_map enable row level security;
alter table private.external_sync_state enable row level security;
revoke all on private.external_status_map from public, anon, authenticated;
revoke all on private.external_sync_state from public, anon, authenticated;

-- Lista (até 50, as verificadas há mais tempo) as solicitações vinculadas e ainda abertas. SÓ a função external-sync (service_role).
create or replace function public.external_sync_pending()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j), '[]'::jsonb) from (
    select jsonb_build_object('id', r.id, 'system', r.external_system, 'external_id', r.external_id) as j
    from public.requests r
    left join private.external_sync_state s on s.request_id = r.id
    where r.external_id is not null and r.external_system is not null
      and r.deleted_at is null and r.merged_into_id is null and r.status not in ('CONCLUIDO', 'ARQUIVADO')
    order by s.checked_at nulls first, r.created_at
    limit 50) x
$$;

-- Aplica o status lido no sistema externo. Só age quando o status externo MUDOU desde a última leitura (a primeira leitura
-- só registra), e só se houver linha na tabela de mapeamento: assim uma decisão manual do PO não é desfeita a cada verificação.
-- A mudança passa pelos mesmos gatilhos de sempre: auditoria (sem autor) e e-mail ao cliente. SÓ a função external-sync.
create or replace function public.external_apply_status(p_id uuid, p_external_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.requests; v_name text := left(trim(coalesce(p_external_status, '')), 120);
        v_key text; v_prev text; v_new public.request_status;
begin
  v_key := private.norm(v_name);
  if v_key = '' then return jsonb_build_object('result', 'ignored'); end if;
  select * into r from public.requests
   where id = p_id and deleted_at is null and merged_into_id is null and external_id is not null;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  select s.external_status into v_prev from private.external_sync_state s where s.request_id = r.id;
  insert into private.external_sync_state (request_id, external_status, checked_at) values (r.id, v_name, now())
  on conflict (request_id) do update set external_status = excluded.external_status, checked_at = excluded.checked_at;
  if v_prev is null then return jsonb_build_object('result', 'baseline'); end if;
  if private.norm(trim(v_prev)) = v_key then return jsonb_build_object('result', 'unchanged'); end if;
  select m.status into v_new from private.external_status_map m where m.system = r.external_system and m.external_status = v_key;
  if v_new is null then return jsonb_build_object('result', 'unmapped', 'external_status', v_name, 'system', r.external_system); end if;
  if r.status = 'ARQUIVADO' or r.status = v_new then return jsonb_build_object('result', 'same'); end if;
  update public.requests set status = v_new where id = r.id;
  return jsonb_build_object('result', 'updated', 'from', r.status, 'to', v_new);
end $$;

-- Chama a função external-sync (mesmo endereço e segredo dos e-mails). Usada pelo agendamento e pelo botão do painel.
create or replace function private.run_external_sync()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select s.value into v_url    from private.app_settings s where s.key = 'notify_url';
  select s.value into v_secret from private.app_settings s where s.key = 'notify_secret';
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then return null; end if;
  return net.http_post(url := regexp_replace(v_url, '/notify/?$', '/external-sync'), body := '{}'::jsonb,
           headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret));
exception when others then return null;
end $$;

-- Botão "Sincronizar status agora" do detalhe da solicitação.
create or replace function public.admin_sync_external_now()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.require('request:export_dev');
  if private.run_external_sync() is null then raise exception 'notify_not_configured'; end if;
  return jsonb_build_object('queued', true);
end $$;

revoke all on function public.external_sync_pending(), public.external_apply_status(uuid, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.external_sync_pending(), public.external_apply_status(uuid, text) to service_role;
  end if;
end $$;
grant execute on function public.find_similar_requests(text, text) to anon, authenticated;
grant execute on function public.admin_sync_external_now() to authenticated;

-- Pede ao PostgREST (API do Supabase) para reler o schema, caso não tenha feito sozinho.
notify pgrst, 'reload schema';

-- ─────────────────────────────── PARTE B (opcional) ────────────────────────
-- Edite SÓ os valores da seção "CONFIGURAÇÃO" abaixo. Deixe como está o que não quiser usar.
do $parte_b$
declare
  -- ===================== CONFIGURAÇÃO =====================
  v_admin_email   text    := null;                    -- e-mail do 1º admin (o usuário já deve existir em Authentication → Users). Ex.: 'voce@empresa.com.br'
  v_admin_nome    text    := 'Administrador';
  v_clinicas      boolean := false;                   -- true = cadastra as clínicas iniciais da planilha
  v_notify_url    text    := null;                    -- ex.: 'https://SEU-PROJETO.supabase.co/functions/v1/notify'  (liga os e-mails)
  v_notify_secret text    := null;                    -- frase longa e aleatória (32+), IGUAL ao WEBHOOK_SECRET da função notify
  v_cron_limpeza  boolean := false;                   -- true = agenda a limpeza mensal de anônimos (exige pg_cron)
  v_cron_sla      boolean := false;                   -- true = agenda o resumo diário de pedidos parados (exige pg_cron e e-mails)
  v_limpar_agora  boolean := false;                   -- true = apaga agora os anônimos com mais de 30 dias e sem arquivos
  v_notify_desligar boolean := false;                 -- true = desliga os e-mails automáticos (apaga URL e segredo gravados)
  v_sla_primeiro_dias int := null;                    -- dias sem resposta para marcar "sem resposta" (vazio = mantém; padrão do sistema: 3)
  v_sla_parado_dias   int := null;                    -- dias sem movimentação para marcar "parada" (vazio = mantém; padrão do sistema: 15)
  v_cron_cancelar boolean := false;                   -- true = cancela todos os agendamentos (limpeza, resumo diário, sincronização)
  v_cron_externo  boolean := false;                   -- true = agenda (a cada 10 min) a leitura do status no Redmine/Pipefy (exige pg_cron, e-mails ligados e a função external-sync)
  -- =========================================================
  v_id uuid;
  v_n  integer;
begin
  if v_admin_email is not null then
    select u.id into v_id from auth.users u where lower(u.email) = lower(v_admin_email);
    if v_id is null then
      raise notice 'ADMIN: o usuário % não existe. Crie-o em Authentication → Users e rode de novo.', v_admin_email;
    else
      insert into public.profiles (id, email, name, role) values (v_id, lower(v_admin_email), v_admin_nome, 'ADMIN')
      on conflict (id) do update set role = 'ADMIN', active = true;
      raise notice 'ADMIN: % liberado como administrador.', v_admin_email;
    end if;
  end if;

  if v_clinicas then
    insert into public.clinics (name) values
      ('Kardiomov'), ('Med Clínica Goianinha'), ('Hospital de Olhos de Parnamirim'), ('Clínica de Olhos Santa Beatriz')
    on conflict (lower(name)) do nothing;
    insert into public.clinic_units (clinic_id, name) select c.id, 'Unidade 1' from public.clinics c
    on conflict (clinic_id, name) do nothing;
    raise notice 'CLÍNICAS: cadastradas.';
  end if;

  if (v_notify_url is null) <> (v_notify_secret is null) then
    raise exception 'Preencha v_notify_url E v_notify_secret juntos (um deles está vazio).';
  end if;
  if v_notify_url is not null and v_notify_secret is not null then
    if v_notify_url !~ '^https://[^\s]+/functions/v1/notify$' then
      raise exception 'v_notify_url deve ter o formato https://SEU-PROJETO.supabase.co/functions/v1/notify';
    end if;
    if length(v_notify_secret) < 32 then
      raise exception 'v_notify_secret precisa ter 32+ caracteres.';
    end if;
    insert into private.app_settings (key, value) values ('notify_url', v_notify_url), ('notify_secret', v_notify_secret)
    on conflict (key) do update set value = excluded.value;
    raise notice 'E-MAILS: ligados.';
  end if;

  if v_notify_desligar then
    delete from private.app_settings where key in ('notify_url', 'notify_secret');
    raise notice 'E-MAILS: desligados.';
  end if;

  if v_sla_primeiro_dias is not null or v_sla_parado_dias is not null then
    if coalesce(v_sla_primeiro_dias, 1) < 1 or coalesce(v_sla_parado_dias, 1) < 1 then
      raise exception 'Os prazos do alerta de atraso precisam ser de 1 dia ou mais.';
    end if;
    if v_sla_primeiro_dias is not null then
      insert into private.app_settings (key, value) values ('sla_first_days', v_sla_primeiro_dias::text)
      on conflict (key) do update set value = excluded.value;
    end if;
    if v_sla_parado_dias is not null then
      insert into private.app_settings (key, value) values ('sla_idle_days', v_sla_parado_dias::text)
      on conflict (key) do update set value = excluded.value;
    end if;
    raise notice 'SLA: prazos atualizados.';
  end if;

  if v_cron_cancelar and exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('conceive_limpeza_anonimos', 'conceive_resumo_sla', 'conceive_sync_externo');
    raise notice 'CRON: agendamentos cancelados.';
  end if;

  -- Resumo no fim: mostra se os e-mails ficaram ligados (assim não depende de adivinhar).
  if exists (select 1 from private.app_settings where key = 'notify_url') and exists (select 1 from private.app_settings where key = 'notify_secret') then
    raise notice 'E-MAILS: LIGADOS no banco (url e segredo gravados). Falta só a função notify e seus Secrets; teste em Equipe → E-mails automáticos → Enviar e-mail de teste.';
  else
    raise notice 'E-MAILS: DESLIGADOS no banco. Preencha v_notify_url e v_notify_secret nesta Parte B e rode o arquivo inteiro de novo.';
  end if;

  if v_limpar_agora then
    delete from auth.users u
    where u.is_anonymous and u.created_at < now() - interval '30 days'
      and not exists (select 1 from storage.objects o where o.owner = u.id);
    get diagnostics v_n = row_count;
    raise notice 'LIMPEZA: % sessões anônimas antigas apagadas.', v_n;
  end if;

  if (v_cron_limpeza or v_cron_sla or v_cron_externo) and not v_cron_cancelar then
    execute 'create extension if not exists pg_cron';
  end if;
  if v_cron_limpeza and not v_cron_cancelar then
    perform cron.unschedule(jobid) from cron.job where jobname = 'conceive_limpeza_anonimos';
    perform cron.schedule('conceive_limpeza_anonimos', '0 3 1 * *', $cron$
      delete from auth.users u
      where u.is_anonymous and u.created_at < now() - interval '30 days'
        and not exists (select 1 from storage.objects o where o.owner = u.id) $cron$);
    raise notice 'CRON: limpeza mensal agendada (dia 1, 03:00 UTC).';
  end if;
  if v_cron_externo and not v_cron_cancelar then
    perform cron.unschedule(jobid) from cron.job where jobname = 'conceive_sync_externo';
    perform cron.schedule('conceive_sync_externo', '*/10 * * * *', $cron$ select private.run_external_sync() $cron$);
    raise notice 'CRON: sincronização do Redmine/Pipefy agendada (a cada 10 minutos).';
  end if;
  if v_cron_sla and not v_cron_cancelar then
    perform cron.unschedule(jobid) from cron.job where jobname = 'conceive_resumo_sla';
    perform cron.schedule('conceive_resumo_sla', '0 11 * * 1-5', $cron$ select private.send_sla_digest() $cron$);
    raise notice 'CRON: resumo diário agendado (seg a sex, 08:00 em Fortaleza).';
  end if;
end
$parte_b$;

notify pgrst, 'reload schema';
