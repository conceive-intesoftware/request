-- OPCIONAL: agenda a limpeza mensal de usuários anônimos antigos, para você não precisar lembrar.
-- Requer a extensão pg_cron: Supabase → Database → Extensions → pg_cron (ligar). Rode este arquivo UMA vez.
-- Roda todo dia 1º, às 03:00 (horário do servidor, UTC). Mesma regra do cleanup_anonymous_users.sql:
-- só apaga sessões anônimas com mais de 30 dias e sem arquivos no Storage; os links de acompanhamento continuam valendo.
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'conceive_limpeza_anonimos';

select cron.schedule(
  'conceive_limpeza_anonimos',
  '0 3 1 * *',
  $$ delete from auth.users u
     where u.is_anonymous
       and u.created_at < now() - interval '30 days'
       and not exists (select 1 from storage.objects o where o.owner = u.id) $$
);

-- Para conferir:   select jobname, schedule, active from cron.job;
-- Para cancelar:   select cron.unschedule('conceive_limpeza_anonimos');
