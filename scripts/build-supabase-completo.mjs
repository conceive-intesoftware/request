// Gera supabase/Supabase-completo.sql = cabeçalho + migração (inteira) + parte opcional configurável.
// Rode depois de mexer na migração:  node scripts/build-supabase-completo.mjs
import { readFileSync, writeFileSync } from "node:fs";
const mig = readFileSync("supabase/migrations/20261121000000_init.sql", "utf8").trimEnd();
const head = `-- ═══════════════════════════════════════════════════════════════════════════
-- SUPABASE-COMPLETO — um único arquivo para todo o lado Supabase (banco) do Conceive.
-- Cole TUDO no SQL Editor e clique em Run. Pode rodar de novo quantas vezes quiser (atualiza sem apagar dados).
--
--   PARTE A  Banco inteiro: tabelas, permissões (RBAC), auditoria, RLS, funções (RPC), Storage, MFA, SLA, métricas…
--   PARTE B  Opcionais controlados por chaves no começo da Parte B (tudo vem DESLIGADO):
--            primeiro administrador, clínicas iniciais, e-mails automáticos, limpeza mensal, resumo diário, limpeza agora.
--
-- As Edge Functions (notify, external-task, admin-users) são código Deno e não rodam no SQL Editor:
-- publique-as em Edge Functions (veja PASSO_A_PASSO.md, Partes 5 e 6).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────── PARTE A ───────────────────────────────────
`;
const partB = `

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

  if v_notify_url is not null and v_notify_secret is not null then
    if length(v_notify_secret) < 32 then
      raise exception 'v_notify_secret precisa ter 32+ caracteres.';
    end if;
    insert into private.app_settings (key, value) values ('notify_url', v_notify_url), ('notify_secret', v_notify_secret)
    on conflict (key) do update set value = excluded.value;
    raise notice 'E-MAILS: ligados.';
  end if;

  if v_limpar_agora then
    delete from auth.users u
    where u.is_anonymous and u.created_at < now() - interval '30 days'
      and not exists (select 1 from storage.objects o where o.owner = u.id);
    get diagnostics v_n = row_count;
    raise notice 'LIMPEZA: % sessões anônimas antigas apagadas.', v_n;
  end if;

  if v_cron_limpeza or v_cron_sla then
    execute 'create extension if not exists pg_cron';
  end if;
  if v_cron_limpeza then
    perform cron.unschedule(jobid) from cron.job where jobname = 'conceive_limpeza_anonimos';
    perform cron.schedule('conceive_limpeza_anonimos', '0 3 1 * *', $cron$
      delete from auth.users u
      where u.is_anonymous and u.created_at < now() - interval '30 days'
        and not exists (select 1 from storage.objects o where o.owner = u.id) $cron$);
    raise notice 'CRON: limpeza mensal agendada (dia 1, 03:00 UTC).';
  end if;
  if v_cron_sla then
    perform cron.unschedule(jobid) from cron.job where jobname = 'conceive_resumo_sla';
    perform cron.schedule('conceive_resumo_sla', '0 11 * * 1-5', $cron$ select private.send_sla_digest() $cron$);
    raise notice 'CRON: resumo diário agendado (seg a sex, 08:00 em Fortaleza).';
  end if;
end
$parte_b$;
`;
writeFileSync("supabase/Supabase-completo.sql", head + mig + partB + "\n");
console.log("✓ supabase/Supabase-completo.sql gerado");
