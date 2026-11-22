-- OPCIONAL: clínicas iniciais (nomes vindos da planilha atual). Edite/adicione à vontade;
-- depois você também pode gerenciar tudo pela tela "Clínicas" do painel.
-- É seguro rodar mais de uma vez.

insert into public.clinics (name) values
  ('Kardiomov'),
  ('Med Clínica Goianinha'),
  ('Hospital de Olhos de Parnamirim'),
  ('Clínica de Olhos Santa Beatriz')
on conflict (lower(name)) do nothing;

insert into public.clinic_units (clinic_id, name)
select c.id, 'Unidade 1' from public.clinics c
on conflict (clinic_id, name) do nothing;

select c.name, array_agg(u.name order by u.name) as unidades
from public.clinics c left join public.clinic_units u on u.clinic_id = c.id
group by c.name order by c.name;
