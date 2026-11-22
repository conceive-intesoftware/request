-- MANUTENÇÃO (rode ~1x por mês no SQL Editor): apaga sessões anônimas antigas.
-- Cada pessoa que envia uma solicitação vira um "usuário anônimo" no Supabase Auth, e o Supabase não limpa isso sozinho.
-- É seguro: o acompanhamento usa o token do link (não a sessão), e as solicitações guardam só o UUID (sem chave estrangeira).
-- Não apaga quem ainda tem arquivos no Storage (esses arquivos pertencem a solicitações ainda ativas).

delete from auth.users u
where u.is_anonymous
  and u.created_at < now() - interval '30 days'
  and not exists (select 1 from storage.objects o where o.owner = u.id);
