-- OPCIONAL: resumo diário por e-mail das solicitações sem resposta ou paradas (segunda a sexta, 08:00 em Fortaleza).
-- Requer: e-mails já configurados (configurar_emails.sql, com TEAM_EMAILS na função notify) e a extensão pg_cron ligada
-- (Supabase → Database → Extensions → pg_cron). Rode UMA vez. Só envia se houver algo a tratar.
-- Prazos padrão: 3 dias para a 1ª resposta e 15 dias sem movimentação. Para mudar:
--   insert into private.app_settings values ('sla_first_days', '2'), ('sla_idle_days', '10')
--   on conflict (key) do update set value = excluded.value;
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'conceive_resumo_sla';

select cron.schedule('conceive_resumo_sla', '0 11 * * 1-5', $$ select private.send_sla_digest() $$);   -- 11:00 UTC = 08:00 em Fortaleza

-- Para testar agora:  select private.send_sla_digest();   (devolve quantas solicitações estão atrasadas)
-- Para cancelar:      select cron.unschedule('conceive_resumo_sla');
