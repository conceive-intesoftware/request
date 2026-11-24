-- Liga os e-mails automáticos (link de acompanhamento ao cliente + avisos à equipe).
-- Rode UMA vez no SQL Editor DEPOIS de publicar a função "notify" (veja o PASSO_A_PASSO, Parte 5).
-- Troque os dois valores abaixo. O segredo precisa ser IGUAL ao WEBHOOK_SECRET cadastrado na função.
--   1) URL:    https://SEU-PROJETO.supabase.co/functions/v1/notify
--   2) Segredo: uma frase longa e aleatória (32+ caracteres). Não reutilize senhas.
insert into private.app_settings (key, value) values
  ('notify_url',    'https://SEU-PROJETO.supabase.co/functions/v1/notify'),
  ('notify_secret', 'TROQUE-POR-UM-SEGREDO-LONGO-E-ALEATORIO')
on conflict (key) do update set value = excluded.value;

-- Para DESLIGAR os e-mails:  delete from private.app_settings where key in ('notify_url','notify_secret');
