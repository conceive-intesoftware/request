-- Libera o PRIMEIRO administrador. Rode no SQL Editor do Supabase DEPOIS de:
--   1) rodar a migração, e
--   2) criar o seu usuário em Authentication → Users (com e-mail e senha).
-- Troque o e-mail e o nome abaixo.

insert into public.profiles (id, email, name, role)
select u.id, lower(u.email), 'Seu Nome Aqui', 'ADMIN'
from auth.users u
where lower(u.email) = lower('voce@suaempresa.com.br')
on conflict (id) do update set role = 'ADMIN', active = true;

-- Conferência: deve listar 1 linha com role = ADMIN.
select id, email, name, role, active from public.profiles;
