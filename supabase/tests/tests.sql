-- Suíte de testes do banco. Rodada por supabase/tests/run.sh (depois do mock + migração).
\set ON_ERROR_STOP on
\set QUIET on

create schema tests;
grant usage on schema tests to public;

create table tests.state (k text primary key, v text);
grant all on tests.state to public;

-- ───────── helpers ─────────
create function tests.set(p_k text, p_v text) returns void language sql as
$$ insert into tests.state values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function tests.get(p_k text) returns text language sql as
$$ select v from tests.state where k = p_k $$;

create function tests.ok(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Executa SQL e exige erro cujo texto case com o padrão.
create function tests.fails(p_sql text, p_pat text, p_msg text) returns void language plpgsql as $$
declare v_failed boolean := false; v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_failed := true; v_err := sqlerrm;
  end;
  if not v_failed then raise exception 'FAIL: % (esperava erro /%/ mas passou)', p_msg, p_pat; end if;
  if v_err !~* p_pat then raise exception 'FAIL: % (erro "%" não casa /%/)', p_msg, v_err, p_pat; end if;
  raise notice 'ok - % [%]', p_msg, left(v_err, 60);
end $$;

create function tests.login(p_uid uuid, p_aal text default 'aal2', p_anon boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'is_anonymous', p_anon)::text, true);
  perform set_config('request.headers',
    '{"x-forwarded-for":"203.0.113.9, 10.0.0.1","user-agent":"test-agent/1.0"}', true);
  execute 'set local role authenticated';
end $$;

create function tests.as_anon_role() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end $$;

create function tests.logout() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- cria uma solicitação com uma sessão anônima NOVA (evita estourar o rate limit entre testes)
create function tests.mk(p_title text, p_clinic uuid default null, p_pending text default null)
returns table (id uuid, token text, protocol text) language plpgsql as $$
declare v_tok text; v_proto text; v_id uuid;
begin
  perform tests.login(gen_random_uuid(), 'aal1', true);
  select s.tracking_token, s.protocol into v_tok, v_proto from public.submit_request(
    p_clinic, null, p_pending, 'Maria Teste', 'RECEPCIONISTA', '84986109779',
    'AGENDA', 'NOVA_FUNCIONALIDADE', p_title, 'Descrição suficientemente longa para passar na validação.', '{}') s;
  perform tests.logout();
  select r.id into v_id from public.requests r where r.tracking_token = v_tok;
  return query select v_id, v_tok, v_proto;
end $$;

-- ───────── fixtures (como superuser) ─────────
insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@x.com'),
  ('a0000000-0000-0000-0000-000000000002', 'po@x.com'),
  ('a0000000-0000-0000-0000-000000000003', 'support@x.com'),
  ('a0000000-0000-0000-0000-000000000004', 'dev@x.com'),
  ('a0000000-0000-0000-0000-000000000005', 'novo@x.com'),
  ('b0000000-0000-0000-0000-000000000001', null),
  ('b0000000-0000-0000-0000-000000000002', null);

insert into public.profiles (id, email, name, role) values
  ('a0000000-0000-0000-0000-000000000001', 'admin@x.com',   'Ana Admin',   'ADMIN'),
  ('a0000000-0000-0000-0000-000000000002', 'po@x.com',      'Paulo PO',    'PO'),
  ('a0000000-0000-0000-0000-000000000003', 'support@x.com', 'Sueli Suporte', 'SUPPORT'),
  ('a0000000-0000-0000-0000-000000000004', 'dev@x.com',     'Davi Dev',    'DEV_VIEWER');

insert into public.clinics (id, name) values ('c0000000-0000-0000-0000-000000000001', 'Kardiomov');
insert into public.clinics (id, name) values ('c0000000-0000-0000-0000-000000000002', 'Hospital de Olhos de Parnamirim');
insert into public.clinic_units (id, clinic_id, name) values
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Unidade 1');
insert into public.clinics (id, name, active) values ('c0000000-0000-0000-0000-000000000003', 'Clínica Inativa', false);

-- ───────── 1. matriz de privilégios ─────────
do $t$ begin
  perform tests.ok(not has_table_privilege('authenticated', 'public.requests', 'select'), 'authenticated NÃO lê requests direto');
  perform tests.ok(not has_table_privilege('authenticated', 'public.requests', 'insert'), 'authenticated NÃO insere em requests');
  perform tests.ok(not has_table_privilege('authenticated', 'public.requests', 'update'), 'authenticated NÃO atualiza requests');
  perform tests.ok(not has_table_privilege('anon', 'public.requests', 'select'), 'anon NÃO lê requests');
  perform tests.ok(not has_table_privilege('authenticated', 'public.profiles', 'select'), 'authenticated NÃO lê profiles');
  perform tests.ok(not has_table_privilege('authenticated', 'public.audit_logs', 'update'), 'authenticated NÃO atualiza audit_logs');
  perform tests.ok(not has_function_privilege('anon', 'public.list_requests(jsonb,int,int)', 'execute'), 'anon NÃO executa list_requests');
  perform tests.ok(not has_function_privilege('anon', 'public.submit_request(uuid,uuid,text,text,public.requester_role,text,public.system_module,public.request_type,text,text,text[])', 'execute'), 'anon sem sessão NÃO envia solicitação');
  perform tests.ok(has_function_privilege('anon', 'public.get_request_by_token(text)', 'execute'), 'anon PODE consultar protocolo por token');
  perform tests.ok(not has_function_privilege('authenticated', 'private.filtered_requests(jsonb)', 'execute'), 'authenticated NÃO executa helper privado');
  perform tests.ok(not has_function_privilege('authenticated', 'private.write_audit(public.audit_action,text,text,jsonb,jsonb)', 'execute'), 'authenticated NÃO escreve auditoria direto');
end $t$;

-- ───────── 2. funções puras ─────────
do $t$ begin
  perform tests.ok(private.normalize_br_phone('(84) 99849-3000') = '+5584998493000', 'telefone com máscara');
  perform tests.ok(private.normalize_br_phone('84998493000') = '+5584998493000', 'telefone só dígitos');
  perform tests.ok(private.normalize_br_phone('84 987417184') = '+5584987417184', 'telefone com espaço (caso real da planilha)');
  perform tests.ok(private.normalize_br_phone('+55 84 99849-3000') = '+5584998493000', 'telefone com DDI');
  perform tests.ok(private.normalize_br_phone('(84) 3211-4455') = '+558432114455', 'fixo de 10 dígitos');
  perform tests.ok(private.normalize_br_phone('(10) 99999-9999') is null, 'DDD inexistente rejeitado');
  perform tests.ok(private.normalize_br_phone('(84) 89999-9999') is null, 'celular sem 9 rejeitado');
  perform tests.ok(private.normalize_br_phone('12345') is null, 'curto demais rejeitado');
  perform tests.ok(private.normalize_br_phone(null) is null, 'null rejeitado');
  perform tests.ok(private.mask_name('Sarah Silva') = 'S**** S****', 'mask_name');
  perform tests.ok(private.mask_name('Ana') = 'A**', 'mask_name curto');
  perform tests.ok(private.mask_phone('+5584998493000') = '(**) *****-3000', 'mask_phone');
  perform tests.ok(private.norm('KARDIÓ Çã') = 'kardio ca', 'normalização de acentos');
end $t$;

-- ───────── 3. permissões por papel (data-driven) ─────────
do $t$
declare n int;
begin
  select count(*) into n from public.role_permissions where role = 'ADMIN';      perform tests.ok(n = 15, 'ADMIN tem 15 permissões');
  select count(*) into n from public.role_permissions where role = 'PO';         perform tests.ok(n = 13, 'PO tem 13 permissões');
  select count(*) into n from public.role_permissions where role = 'SUPPORT';    perform tests.ok(n = 6, 'SUPPORT tem 6 permissões');
  select count(*) into n from public.role_permissions where role = 'DEV_VIEWER'; perform tests.ok(n = 2, 'DEV_VIEWER tem 2 permissões');
  perform tests.ok(not exists (select 1 from public.role_permissions where role = 'DEV_VIEWER' and permission = 'pii:view'), 'DEV não vê PII');
  perform tests.ok(not exists (select 1 from public.role_permissions where role = 'SUPPORT' and permission in ('request:update_status','report:export','audit:read')), 'SUPPORT não muda status/exporta/audita');
end $t$;

-- ───────── 4. clínicas: busca e unidades ─────────
do $t$
declare n int;
begin
  perform tests.login('b0000000-0000-0000-0000-000000000001', 'aal1', true);
  select count(*) into n from public.search_clinics('ka');          perform tests.ok(n = 0, 'busca com <3 letras não lista nada');
  select count(*) into n from public.search_clinics('kardio');      perform tests.ok(n = 1, 'busca "kardio" acha 1');
  select count(*) into n from public.search_clinics('KARDIÓ');      perform tests.ok(n = 1, 'busca ignora acento/caixa');
  select count(*) into n from public.search_clinics('%%%');         perform tests.ok(n = 0, 'curinga % é escapado');
  select count(*) into n from public.search_clinics('inativa');     perform tests.ok(n = 0, 'clínica inativa não aparece');
  select count(*) into n from public.list_units('c0000000-0000-0000-0000-000000000001'); perform tests.ok(n = 1, 'lista unidades');
  perform tests.logout();
end $t$;

-- ───────── 5. envio público ─────────
do $t$
declare v_proto text; v_tok text; v_proto2 text; v_row record;
begin
  perform tests.login('b0000000-0000-0000-0000-000000000001', 'aal1', true);
  select s.protocol, s.tracking_token into v_proto, v_tok from public.submit_request(
    'c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', null,
    'Sarah Silva', 'ADMINISTRADOR', '(84) 99849-3000', 'FINANCEIRO', 'MELHORIA_FLUXO',
    'Pagamento antecipado de percentual', 'Definimos que iremos solicitar aos pacientes um percentual antecipado.', '{}') s;
  perform tests.ok(v_proto ~ '^CON-[0-9]{4}-[0-9]{4}$', 'protocolo no formato CON-AAAA-NNNN: ' || v_proto);
  perform tests.ok(v_tok ~ '^[0-9a-f]{48}$', 'token de acompanhamento com 48 hex');
  select s.protocol into v_proto2 from public.submit_request(
    null, null, 'Clínica Nova Ltda', 'Ilnara Souza', 'RECEPCIONISTA', '84986109779', 'AGENDA', 'SUGESTAO_TECNICA',
    'Sugestão técnica de agenda', 'Exemplo de utilização: o paciente realiza um exame e o atendimento muda.', '{}') s;
  perform tests.ok(v_proto2 <> v_proto and right(v_proto2, 4)::int = right(v_proto, 4)::int + 1, 'protocolo sequencial: ' || v_proto2);
  perform tests.logout();
  perform tests.set('proto1', v_proto); perform tests.set('token1', v_tok);
  select r.whatsapp_e164, r.status, r.submitted_by, r.requester_name into v_row from public.requests r where r.protocol = v_proto;
  perform tests.ok(v_row.whatsapp_e164 = '+5584998493000', 'WhatsApp gravado em E.164');
  perform tests.ok(v_row.status = 'RECEBIDO', 'status inicial RECEBIDO');
  perform tests.ok(v_row.submitted_by = 'b0000000-0000-0000-0000-000000000001', 'submitted_by = sessão anônima');
  perform tests.ok((select count(*) from public.audit_logs where entity = 'requests' and action = 'CREATE' and entity_id = (select id::text from public.requests where protocol = v_proto)) = 1, 'CREATE auditado');
  perform tests.ok((select ip_address from public.audit_logs where entity='requests' and action='CREATE' order by id limit 1) = '203.0.113.9', 'IP capturado do x-forwarded-for');
  perform tests.ok((select user_agent from public.audit_logs where entity='requests' and action='CREATE' order by id limit 1) = 'test-agent/1.0', 'user-agent capturado');
end $t$;

do $t$
begin
  perform tests.login('b0000000-0000-0000-0000-000000000002', 'aal1', true);
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fulano de Tal','MEDICO','123','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.','{}')$$, 'invalid_phone', 'telefone inválido rejeitado');
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','abc','Descrição longa o bastante para validar.','{}')$$, 'invalid_title', 'título curto rejeitado');
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','curta','{}')$$, 'invalid_description', 'descrição curta rejeitada');
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fu','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.','{}')$$, 'invalid_name', 'nome curto rejeitado');
  perform tests.fails($$select * from public.submit_request(null,null,null,'Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.','{}')$$, 'clinic_required', 'sem clínica nem nome pendente rejeitado');
  perform tests.fails($$select * from public.submit_request('c0000000-0000-0000-0000-000000000009',null,null,'Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.','{}')$$, 'invalid_clinic', 'clínica inexistente rejeitada');
  perform tests.fails($$select * from public.submit_request('c0000000-0000-0000-0000-000000000003',null,null,'Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.','{}')$$, 'invalid_clinic', 'clínica inativa rejeitada');
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.',array['b0000000-0000-0000-0000-000000000002/nao-existe.png'])$$, 'invalid_attachment', 'anexo inexistente rejeitado');
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.',array['outro-uid/x.png'])$$, 'invalid_attachment', 'anexo de outra pasta rejeitado');
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X Ltda','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante para validar.',array['a','b','c','d','e','f'])$$, 'too_many_attachments', 'mais de 5 anexos rejeitado');
  perform tests.logout();
  perform tests.ok(not exists (select 1 from public.requests where submitted_by = 'b0000000-0000-0000-0000-000000000002'), 'nenhuma linha criada pelas tentativas inválidas');
end $t$;

do $t$
declare i int;
begin
  perform tests.login('b0000000-0000-0000-0000-000000000002', 'aal1', true);
  for i in 1..5 loop
    perform * from public.submit_request(null,null,'Clínica Spam Ltda','Spammer Teste','OUTRO','84998493000','OUTRO','NOVA_FUNCIONALIDADE','Spam número ' || i,'Descrição longa o bastante para validar o envio.','{}');
  end loop;
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica Spam Ltda','Spammer Teste','OUTRO','84998493000','OUTRO','NOVA_FUNCIONALIDADE','Spam número 6','Descrição longa o bastante para validar o envio.','{}')$$, 'rate_limited', '6º envio em 10 min bloqueado (rate limit)');
  perform tests.logout();
end $t$;

-- ───────── 6. cliente anônimo não acessa nada além do seu envio ─────────
do $t$
declare c int;
begin
  perform tests.login('b0000000-0000-0000-0000-000000000001', 'aal1', true);
  perform tests.fails('select * from public.requests', 'permission denied', 'anônimo não lê requests');
  perform tests.fails($$insert into public.requests (protocol) values ('X')$$, 'permission denied', 'anônimo não insere direto em requests');
  perform tests.fails($$update public.requests set status = 'CONCLUIDO'$$, 'permission denied', 'anônimo não atualiza requests');
  perform tests.fails($$delete from public.requests$$, 'permission denied', 'anônimo não apaga requests');
  perform tests.fails($$select public.list_requests()$$, 'forbidden', 'anônimo não chama list_requests');
  perform tests.fails($$select public.get_request_detail(gen_random_uuid())$$, 'forbidden', 'anônimo não chama get_request_detail');
  perform tests.fails($$select public.export_requests()$$, 'forbidden', 'anônimo não exporta');
  perform tests.fails($$select public.admin_list_staff()$$, 'forbidden', 'anônimo não lista equipe');
  perform tests.fails($$select * from public.profiles$$, 'permission denied', 'anônimo não lê profiles');
  select count(*) into c from public.audit_logs; perform tests.ok(c = 0, 'RLS: anônimo enxerga 0 linhas de audit_logs');
  select count(*) into c from public.clinics;    perform tests.ok(c = 0, 'RLS: anônimo enxerga 0 clínicas na tabela');
  perform tests.logout();
  perform tests.as_anon_role();
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica X','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Título válido','Descrição longa o bastante.','{}')$$, 'permission denied', 'role anon sem sessão não envia');
  perform tests.logout();
end $t$;

-- ───────── 7. acompanhamento por token ─────────
do $t$
declare j jsonb;
begin
  perform tests.as_anon_role();
  j := public.get_request_by_token(tests.get('token1'));
  perform tests.ok(j ->> 'status' = 'RECEBIDO' and j ->> 'title' = 'Pagamento antecipado de percentual', 'tracking devolve status e título');
  perform tests.ok(not (j ? 'requester_name') and not (j ? 'whatsapp') and not (j ? 'clinic_id') and not (j ? 'description'), 'tracking NÃO expõe dados pessoais/clínica');
  perform tests.ok(public.get_request_by_token('nao-e-token') is null, 'token malformado -> null');
  perform tests.ok(public.get_request_by_token(repeat('a', 48)) is null, 'token inexistente -> null');
  perform tests.ok(public.get_request_by_token(upper(tests.get('token1'))) is null, 'token em maiúsculas -> null');
  perform tests.logout();
end $t$;

-- ───────── 8. equipe sem MFA (aal1) não tem poder nenhum ─────────
do $t$
declare j jsonb;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal1');
  j := public.my_context();
  perform tests.ok(j ->> 'role' is null and j ->> 'aal' = 'aal1', 'admin em aal1: my_context sem papel');
  perform tests.fails($$select public.list_requests()$$, 'forbidden', 'ADMIN sem MFA não lista solicitações');
  perform tests.fails($$select public.admin_list_staff()$$, 'forbidden', 'ADMIN sem MFA não lista equipe');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.my_context();
  perform tests.ok(j ->> 'role' = 'PO' and j -> 'permissions' ? 'report:export', 'PO em aal2: papel e permissões');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');
  j := public.my_context();
  perform tests.ok(j ->> 'role' = 'DEV_VIEWER' and not (j -> 'permissions' ? 'pii:view'), 'DEV: sem pii:view');
  perform tests.logout();
  perform tests.login('b0000000-0000-0000-0000-000000000001', 'aal1', true);
  j := public.my_context();
  perform tests.ok(j ->> 'role' is null and (j ->> 'is_anonymous')::boolean, 'anônimo: sem papel');
  perform tests.logout();
end $t$;

-- ───────── 9. mascaramento LGPD ─────────
do $t$
declare j jsonb; r jsonb;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');     -- PO
  j := public.list_requests('{"q":"Pagamento"}'::jsonb);
  r := j -> 'rows' -> 0;
  perform tests.ok((j ->> 'total')::int = 1, 'PO: filtro por título acha 1');
  perform tests.ok(r ->> 'requester_name' = 'Sarah Silva' and r ->> 'whatsapp' = '+5584998493000' and not (r ->> 'pii_masked')::boolean, 'PO vê dados pessoais');
  perform tests.ok((public.list_requests('{"q":"Sarah"}'::jsonb) ->> 'total')::int = 1, 'PO busca por nome do solicitante');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');     -- SUPPORT
  r := public.list_requests('{"q":"Pagamento"}'::jsonb) -> 'rows' -> 0;
  perform tests.ok(r ->> 'requester_name' = 'Sarah Silva', 'SUPPORT vê dados pessoais');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');     -- DEV
  r := public.list_requests('{"q":"Pagamento"}'::jsonb) -> 'rows' -> 0;
  perform tests.ok(r ->> 'requester_name' = 'S**** S****' and r ->> 'whatsapp' = '(**) *****-3000' and (r ->> 'pii_masked')::boolean, 'DEV vê nome/telefone MASCARADOS');
  perform tests.ok((public.list_requests('{"q":"Sarah"}'::jsonb) ->> 'total')::int = 0, 'DEV NÃO consegue buscar por nome (evita inferência)');
  perform tests.ok(r -> 'rice_score' is not null, 'DEV vê campos não sensíveis');
  perform tests.logout();
end $t$;

-- ───────── 10. detalhe + VIEW_SENSITIVE ─────────
do $t$
declare v_id uuid; j jsonb; n0 int; n1 int;
begin
  select id into v_id from public.requests where protocol = tests.get('proto1');
  perform tests.set('id1', v_id::text);
  select count(*) into n0 from public.audit_logs where action = 'VIEW_SENSITIVE' and entity_id = v_id::text;

  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');     -- DEV
  j := public.get_request_detail(v_id);
  perform tests.ok(j ->> 'requester_name' = 'S**** S****' and j ->> 'whatsapp' = '(**) *****-3000', 'DEV: detalhe mascarado');
  perform tests.ok(j -> 'audit' = 'null'::jsonb, 'DEV: não recebe trilha de auditoria');
  perform tests.logout();
  select count(*) into n1 from public.audit_logs where action = 'VIEW_SENSITIVE' and entity_id = v_id::text;
  perform tests.ok(n1 = n0, 'DEV não gera VIEW_SENSITIVE');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');     -- PO
  j := public.get_request_detail(v_id);
  perform tests.ok(j ->> 'requester_name' = 'Sarah Silva' and j ->> 'clinic_name' = 'Kardiomov' and j ->> 'unit_name' = 'Unidade 1', 'PO: detalhe completo');
  perform tests.ok(jsonb_typeof(j -> 'audit') = 'array' and jsonb_array_length(j -> 'audit') >= 2, 'PO recebe trilha de auditoria');
  perform tests.ok(j -> 'audit' @> '[{"action":"VIEW_SENSITIVE"}]'::jsonb, 'a própria visualização aparece na trilha');
  perform tests.logout();
  select count(*) into n1 from public.audit_logs where action = 'VIEW_SENSITIVE' and entity_id = v_id::text;
  perform tests.ok(n1 = n0 + 1, 'PO gera exatamente 1 VIEW_SENSITIVE');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform tests.ok(public.get_request_detail(gen_random_uuid()) is null, 'detalhe de id inexistente -> null');
  perform tests.logout();
end $t$;

-- ───────── 11. status / RICE / tags ─────────
do $t$
declare v_id uuid := tests.get('id1')::uuid; s numeric; a record; j jsonb;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');     -- SUPPORT
  perform tests.fails(format($$select public.set_request_status(%L, 'EM_ANALISE_PRODUTO')$$, v_id), 'forbidden', 'SUPPORT não muda status');
  perform tests.fails(format($$select public.set_request_priority(%L, 'ALTA', 10, 1, 0.5, 1)$$, v_id), 'forbidden', 'SUPPORT não prioriza');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');     -- DEV
  perform tests.fails(format($$select public.set_request_status(%L, 'EM_ANALISE_PRODUTO')$$, v_id), 'forbidden', 'DEV não muda status');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');     -- PO
  perform public.set_request_status(v_id, 'EM_ANALISE_PRODUTO');
  s := public.set_request_priority(v_id, 'ALTA', 100, 2, 0.8, 4);
  perform tests.ok(s = 40.00, 'RICE = (100*2*0.8)/4 = 40 calculado no banco');
  perform tests.fails(format($$select public.set_request_priority(%L, 'ALTA', 100, 5, 0.8, 4)$$, v_id), 'check|violates', 'impacto fora da escala rejeitado');
  perform tests.fails(format($$select public.set_request_priority(%L, 'ALTA', 100, 2, 1.5, 4)$$, v_id), 'check|violates', 'confiança >1 rejeitada');
  perform tests.fails(format($$select public.set_request_priority(%L, 'ALTA', 100, 2, 0.8, 0)$$, v_id), 'check|violates', 'esforço 0 rejeitado');
  perform public.set_request_tags(v_id, array['Financeiro ', ' urgente', '']);
  j := public.get_request_detail(v_id);
  perform tests.ok(j -> 'tags' = '["financeiro","urgente"]'::jsonb, 'tags normalizadas');
  perform tests.ok((j -> 'rice' ->> 'score')::numeric = 40, 'detalhe mostra RICE');
  perform tests.logout();

  select * into a from public.audit_logs
   where entity = 'requests' and entity_id = v_id::text and action = 'UPDATE'
     and previous_value ->> 'status' = 'RECEBIDO' and new_value ->> 'status' = 'EM_ANALISE_PRODUTO'
   order by id limit 1;
  perform tests.ok(a.id is not null and a.user_id = 'a0000000-0000-0000-0000-000000000002', 'UPDATE de status auditado com antes/depois e autor');

  perform tests.as_anon_role();
  perform tests.ok(public.get_request_by_token(tests.get('token1')) ->> 'status' = 'EM_ANALISE_PRODUTO', 'cliente vê o novo status no acompanhamento');
  perform tests.logout();
end $t$;

-- ───────── 12. comentários internos x públicos ─────────
do $t$
declare v_id uuid := tests.get('id1')::uuid; j jsonb;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');     -- DEV
  perform tests.fails(format($$select public.add_comment(%L, 'resposta pública do dev', false)$$, v_id), 'forbidden', 'DEV não responde publicamente');
  perform public.add_comment(v_id, 'nota técnica interna', true);
  perform tests.ok(true, 'DEV comenta internamente');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');     -- SUPPORT
  perform public.add_comment(v_id, 'Olá! Estamos analisando seu pedido.', false);
  perform public.add_comment(v_id, 'cliente é antigo, priorizar', true);
  perform tests.fails(format($$select public.add_comment(%L, '   ', true)$$, v_id), 'invalid_comment', 'comentário vazio rejeitado');
  perform tests.fails($$select public.add_comment(gen_random_uuid(), 'x', true)$$, 'not_found', 'comentário em solicitação inexistente rejeitado');
  perform tests.logout();

  perform tests.as_anon_role();
  j := public.get_request_by_token(tests.get('token1'));
  perform tests.ok(jsonb_array_length(j -> 'comments') = 1 and j -> 'comments' -> 0 ->> 'body' = 'Olá! Estamos analisando seu pedido.', 'cliente vê SÓ a resposta pública');
  perform tests.ok(j::text not like '%nota técnica%' and j::text not like '%priorizar%', 'comentários internos não vazam');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.get_request_detail(v_id);
  perform tests.ok(jsonb_array_length(j -> 'comments') = 3, 'equipe vê os 3 comentários');
  perform tests.ok(j -> 'audit' @> '[{"entity":"request_comments","action":"CREATE"}]'::jsonb, 'criação de comentário aparece na auditoria da solicitação');
  perform tests.logout();
end $t$;

-- ───────── 13. mesclagem ─────────
do $t$
declare a record; b record; c record; j jsonb;
begin
  select * into a from tests.mk('Pedido A original', 'c0000000-0000-0000-0000-000000000001');
  select * into b from tests.mk('Pedido B igual ao A', 'c0000000-0000-0000-0000-000000000002');
  select * into c from tests.mk('Pedido C também igual', null, 'Clínica Pendente SA');

  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');
  perform tests.fails(format($$select public.merge_request(%L, %L)$$, b.id, a.id), 'forbidden', 'SUPPORT não mescla');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform tests.fails(format($$select public.merge_request(%L, %L)$$, a.id, a.id), 'invalid_merge', 'não mescla consigo mesma');
  perform public.merge_request(b.id, a.id);
  j := public.get_request_detail(a.id);
  perform tests.ok(jsonb_array_length(j -> 'duplicates') = 1 and j -> 'duplicates' -> 0 ->> 'protocol' = b.protocol, 'A lista B como similar');
  perform public.merge_request(c.id, b.id);                       -- B já é filha de A → C aponta para A
  j := public.get_request_detail(a.id);
  perform tests.ok(jsonb_array_length(j -> 'duplicates') = 2, 'mesclar em filha aponta para a raiz (2 similares em A)');
  perform tests.fails(format($$select public.merge_request(%L, %L)$$, a.id, c.id), 'invalid_merge', 'não cria ciclo (raiz em filha)');
  perform tests.ok((select (r ->> 'duplicates_count')::int from jsonb_array_elements(public.list_requests('{"q":"Pedido A"}'::jsonb) -> 'rows') r limit 1) = 2, 'lista mostra duplicates_count=2');
  perform public.unmerge_request(c.id);
  perform tests.ok(jsonb_array_length(public.get_request_detail(a.id) -> 'duplicates') = 1, 'desmesclar remove 1 similar');
  perform tests.logout();
end $t$;

-- ───────── 14. vincular clínica / referência externa ─────────
do $t$
declare p record; j jsonb;
begin
  select * into p from tests.mk('Pedido de clínica nova', null, 'Clínica Nova Ltda');
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');
  perform tests.fails(format($$select public.link_request_clinic(%L, 'c0000000-0000-0000-0000-000000000001')$$, p.id), 'forbidden', 'DEV não vincula clínica');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');
  perform public.link_request_clinic(p.id, 'c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001');
  perform tests.fails(format($$select public.link_request_clinic(%L, gen_random_uuid())$$, p.id), 'invalid_clinic', 'clínica inválida rejeitada');
  perform tests.fails(format($$select public.set_external_ref(%L, 'REDMINE', '123')$$, p.id), 'forbidden', 'SUPPORT não exporta p/ dev');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.get_request_detail(p.id);
  perform tests.ok(j ->> 'clinic_name' = 'Kardiomov' and j ->> 'pending_clinic_name' is null, 'vínculo de clínica aplicado');
  perform public.set_external_ref(p.id, 'REDMINE', '#4521');
  perform tests.fails(format($$select public.set_external_ref(%L, 'JIRA', '1')$$, p.id), 'invalid_system', 'sistema externo inválido rejeitado');
  j := public.get_request_detail(p.id);
  perform tests.ok(j ->> 'external_system' = 'REDMINE' and j ->> 'external_id' = '#4521', 'ID externo salvo');
  perform tests.logout();
end $t$;

-- ───────── 15. arquivar (soft delete) e DELETE físico bloqueado ─────────
do $t$
declare p record; n int;
begin
  select * into p from tests.mk('Pedido para arquivar', 'c0000000-0000-0000-0000-000000000001');
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');
  perform tests.fails(format($$select public.archive_request(%L)$$, p.id), 'forbidden', 'SUPPORT não arquiva');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.archive_request(p.id);
  perform tests.ok((public.list_requests(jsonb_build_object('q', 'para arquivar')) ->> 'total')::int = 0, 'arquivada some da lista');
  perform tests.ok(public.get_request_detail(p.id) is null, 'arquivada some do detalhe');
  perform tests.fails(format($$select public.set_request_status(%L, 'CONCLUIDO')$$, p.id), 'not_found', 'arquivada não aceita mudanças');
  perform tests.logout();
  perform tests.ok((select deleted_by from public.requests where id = p.id) = 'a0000000-0000-0000-0000-000000000002', 'deleted_by preenchido');
  perform tests.ok((select deleted_at is not null and status = 'ARQUIVADO' from public.requests where id = p.id), 'deleted_at preenchido e status ARQUIVADO');
  select count(*) into n from public.audit_logs where entity = 'requests' and entity_id = p.id::text and action = 'DELETE';
  perform tests.ok(n = 1, 'soft delete registrado como DELETE na trilha');
  perform tests.fails(format($$delete from public.requests where id = %L$$, p.id), 'DELETE físico proibido', 'DELETE físico bloqueado (até para superuser)');
  perform tests.as_anon_role();
  perform tests.ok(public.get_request_by_token(p.token) ->> 'status' = 'ARQUIVADO', 'cliente vê ARQUIVADO');
  perform tests.logout();
end $t$;

-- ───────── 16. imutabilidade e acesso à trilha ─────────
do $t$
declare n int;
begin
  perform tests.fails($$update public.audit_logs set entity = 'x'$$, 'imutável', 'UPDATE em audit_logs bloqueado');
  perform tests.fails($$delete from public.audit_logs$$, 'imutável', 'DELETE em audit_logs bloqueado');
  perform tests.fails($$truncate public.audit_logs$$, 'imutável', 'TRUNCATE em audit_logs bloqueado');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  select count(*) into n from public.audit_logs; perform tests.ok(n > 10, 'PO lê audit_logs via RLS (' || n || ' linhas)');
  perform tests.fails($$update public.audit_logs set entity = 'x'$$, 'permission denied', 'PO não altera audit_logs');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');
  select count(*) into n from public.audit_logs; perform tests.ok(n = 0, 'SUPPORT enxerga 0 linhas de audit_logs');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal1');
  select count(*) into n from public.audit_logs; perform tests.ok(n = 0, 'ADMIN sem MFA enxerga 0 linhas de audit_logs');
  perform tests.logout();
end $t$;

-- ───────── 17. exportação ─────────
do $t$
declare j jsonb; n0 int; n1 int; a record;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');
  perform tests.fails($$select public.export_requests()$$, 'forbidden', 'SUPPORT não exporta');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');
  perform tests.fails($$select public.export_requests()$$, 'forbidden', 'DEV não exporta');
  perform tests.logout();

  select count(*) into n0 from public.audit_logs where action = 'EXPORT';
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.export_requests('{"module":"AGENDA"}'::jsonb);
  perform tests.logout();
  select count(*) into n1 from public.audit_logs where action = 'EXPORT';
  perform tests.ok(jsonb_typeof(j) = 'array' and jsonb_array_length(j) >= 1, 'PO exporta (' || jsonb_array_length(j) || ' linhas)');
  perform tests.ok(n1 = n0 + 1, 'exportação registrada na trilha');
  select * into a from public.audit_logs where action = 'EXPORT' order by id desc limit 1;
  perform tests.ok((a.new_value ->> 'row_count')::int = jsonb_array_length(j) and a.new_value -> 'filters' ->> 'module' = 'AGENDA', 'auditoria guarda filtros e contagem');
  perform tests.ok(j::text not like '%requester_name%' and j::text not like '%+55%' and j::text not like '%Maria Teste%', 'exportação não contém dados pessoais');
end $t$;

-- ───────── 18. filtros da lista ─────────
do $t$
declare j jsonb;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.list_requests('{"status":"EM_ANALISE_PRODUTO"}'::jsonb);
  perform tests.ok((j ->> 'total')::int = 1, 'filtro por status');
  j := public.list_requests('{"module":"FINANCEIRO"}'::jsonb);
  perform tests.ok((j ->> 'total')::int = 1, 'filtro por módulo');
  j := public.list_requests('{"priority":"ALTA"}'::jsonb);
  perform tests.ok((j ->> 'total')::int = 1, 'filtro por prioridade');
  j := public.list_requests('{"requester_role":"ADMINISTRADOR"}'::jsonb);
  perform tests.ok((j ->> 'total')::int = 1, 'filtro por cargo');
  j := public.list_requests('{"clinic_id":"c0000000-0000-0000-0000-000000000001"}'::jsonb);
  perform tests.ok((j ->> 'total')::int >= 2, 'filtro por clínica');
  j := public.list_requests(jsonb_build_object('from', to_char(now() at time zone 'America/Fortaleza', 'YYYY-MM-DD'), 'to', to_char(now() at time zone 'America/Fortaleza', 'YYYY-MM-DD')));
  perform tests.ok((j ->> 'total')::int >= 5, 'filtro por data (hoje)');
  j := public.list_requests('{"from":"2020-01-01","to":"2020-01-02"}'::jsonb);
  perform tests.ok((j ->> 'total')::int = 0, 'filtro por data (passado distante)');
  j := public.list_requests('{}'::jsonb, 1, 2);
  perform tests.ok(jsonb_array_length(j -> 'rows') = 2 and (j ->> 'total')::int > 2, 'paginação');
  j := public.list_requests('{"q":"100%"}'::jsonb);
  perform tests.ok((j ->> 'total')::int = 0, 'curinga na busca é escapado');
  perform tests.fails($$select public.list_requests('{"status":"INVENTADO"}'::jsonb)$$, 'invalid input value', 'status inválido no filtro dá erro (não ignora)');
  perform tests.logout();
end $t$;

-- ───────── 19. administração ─────────
do $t$
declare j jsonb; v_id uuid; v_unit uuid;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');    -- PO
  perform tests.fails($$select public.admin_upsert_staff('novo@x.com', 'Novo Dev', 'DEV_VIEWER', true)$$, 'forbidden', 'PO não gerencia equipe');
  perform tests.fails($$select public.admin_upsert_clinic(null, 'Clínica PO', true)$$, 'forbidden', 'PO não cadastra clínica');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal2');    -- ADMIN
  perform public.admin_upsert_staff('novo@x.com', 'Novo Dev', 'DEV_VIEWER', true);
  j := public.admin_list_staff();
  perform tests.ok(jsonb_array_length(j) = 5, 'ADMIN adiciona membro (5 na equipe)');
  perform tests.fails($$select public.admin_upsert_staff('naoexiste@x.com', 'Fulano Teste', 'PO', true)$$, 'user_not_found', 'e-mail sem conta no Auth rejeitado');
  perform tests.fails($$select public.admin_upsert_staff('admin@x.com', 'Ana Admin', 'PO', true)$$, 'last_admin', 'não rebaixa o último admin');
  perform tests.fails($$select public.admin_upsert_staff('admin@x.com', 'Ana Admin', 'ADMIN', false)$$, 'last_admin', 'não desativa o último admin');
  v_id := public.admin_upsert_clinic(null, 'Clínica Criada pelo Admin', true);
  v_unit := public.admin_add_unit(v_id, 'Matriz');
  perform tests.ok(v_id is not null and v_unit is not null, 'ADMIN cria clínica e unidade');
  perform tests.fails($$select public.admin_upsert_clinic(null, 'clínica criada pelo admin', true)$$, 'duplicate|unique', 'nome de clínica duplicado (case-insensitive) rejeitado');
  perform public.admin_upsert_clinic(v_id, 'Clínica Criada pelo Admin', false);
  perform tests.ok((select count(*) from public.clinics where id = v_id and not active) = 1, 'ADMIN desativa clínica');
  perform tests.logout();
  perform tests.ok(exists (select 1 from public.audit_logs where entity = 'profiles' and action = 'CREATE'), 'criação de membro auditada');
  perform tests.ok(exists (select 1 from public.audit_logs where entity = 'clinics' and action = 'UPDATE'), 'edição de clínica auditada');

  -- com 2 admins, rebaixar um é permitido
  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal2');
  perform public.admin_upsert_staff('novo@x.com', 'Novo Admin', 'ADMIN', true);
  perform public.admin_upsert_staff('novo@x.com', 'Novo Admin', 'DEV_VIEWER', true);
  perform tests.ok(true, 'com 2 admins, rebaixar um é permitido');
  perform tests.logout();

  -- profiles não vaza hash/segredo e o audit de profiles não existe campo sensível por design (sem colunas sensíveis)
  perform tests.ok(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name ~ 'pass|secret|hash'), 'profiles não guarda senha/segredo (fica no Supabase Auth)');
end $t$;

-- ───────── 20. login auditado ─────────
do $t$
declare n0 int; n1 int;
begin
  select count(*) into n0 from public.audit_logs where action = 'LOGIN';
  perform tests.login('b0000000-0000-0000-0000-000000000001', 'aal1', true);
  perform public.log_login();
  perform tests.logout();
  select count(*) into n1 from public.audit_logs where action = 'LOGIN';
  perform tests.ok(n1 = n0, 'anônimo não gera LOGIN');
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.log_login();
  perform tests.logout();
  select count(*) into n1 from public.audit_logs where action = 'LOGIN';
  perform tests.ok(n1 = n0 + 1, 'login de PO (aal2) auditado');
end $t$;

-- ───────── 21. anexos / Storage ─────────
do $t$
declare v_uid uuid := 'b0000000-0000-0000-0000-000000000001'; v_path text; v_tok text; v_n int; a record; v_rid uuid;
begin
  v_path := v_uid || '/11111111-2222-3333-4444-555555555555__print da tela.png';
  perform tests.login(v_uid, 'aal1', true);
  insert into storage.objects (bucket_id, name, owner, metadata)
    values ('attachments', v_path, v_uid, '{"mimetype":"image/png","size":2048}');
  perform tests.ok(true, 'anônimo envia arquivo para a PRÓPRIA pasta');
  perform tests.fails($$insert into storage.objects (bucket_id, name, owner, metadata) values ('attachments', 'a0000000-0000-0000-0000-000000000001/x.png', null, '{}')$$, 'row-level security', 'anônimo NÃO envia para pasta de outro usuário');
  perform tests.fails($$insert into storage.objects (bucket_id, name, owner, metadata) values ('attachments', 'x.png', null, '{}')$$, 'row-level security', 'anônimo NÃO envia na raiz do bucket');
  select count(*) into v_n from storage.objects; perform tests.ok(v_n = 0, 'anônimo NÃO lista arquivos (nem os próprios)');

  select s.tracking_token into v_tok from public.submit_request(null, null, 'Clínica com Anexo', 'Fulano Anexo', 'MEDICO', '84998493000',
     'PRONTUARIO', 'NOVA_FUNCIONALIDADE', 'Pedido com anexo', 'Descrição longa o bastante para validar o envio.', array[v_path]) s;
  perform tests.logout();

  select * into a from public.request_attachments where storage_path = v_path;
  perform tests.ok(a.file_name = 'print da tela.png' and a.mime_type = 'image/png' and a.size_bytes = 2048, 'anexo vinculado com nome/mime/tamanho reais do Storage');

  v_rid := (select id from public.requests where tracking_token = v_tok);
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  select count(*) into v_n from storage.objects; perform tests.ok(v_n = 1, 'PO (aal2) lê objetos do bucket p/ gerar URL assinada');
  perform tests.ok(jsonb_array_length(public.get_request_detail(v_rid) -> 'attachments') = 1, 'detalhe lista o anexo');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal1');
  select count(*) into v_n from storage.objects; perform tests.ok(v_n = 0, 'equipe sem MFA NÃO lê anexos');
  perform tests.logout();
  perform tests.ok((select not public and file_size_limit = 26214400 from storage.buckets where id = 'attachments'), 'bucket privado com limite de 25 MB');
  perform tests.ok((select allowed_mime_types @> array['image/png','application/pdf','video/mp4'] and not allowed_mime_types @> array['text/html'] from storage.buckets where id = 'attachments'), 'bucket só aceita tipos permitidos');
end $t$;

-- ───────── 21b. teto de uploads por sessão ─────────
do $t$
declare v_uid uuid := 'b0000000-0000-0000-0000-000000000002'; i int; v_n int;
begin
  perform tests.login(v_uid, 'aal1', true);
  for i in 1..50 loop
    insert into storage.objects (bucket_id, name, owner, metadata)
      values ('attachments', v_uid || '/lote-' || i || '.png', v_uid, '{"mimetype":"image/png","size":1}');
  end loop;
  perform tests.ok(true, 'sessão envia 50 arquivos');
  perform tests.fails(format($$insert into storage.objects (bucket_id, name, owner, metadata) values ('attachments', %L, %L, '{}')$$, v_uid || '/lote-51.png', v_uid),
    'row-level security', '51º arquivo da mesma sessão é bloqueado');
  perform tests.logout();
  select count(*) into v_n from storage.objects where (storage.foldername(name))[1] = v_uid::text;
  perform tests.ok(v_n = 50, 'exatamente 50 arquivos gravados');
  perform tests.ok(not has_function_privilege('anon', 'private.my_upload_count()', 'execute'), 'anon não executa my_upload_count');
end $t$;

-- ───────── 22. invariantes ─────────
do $t$
declare v_id uuid := tests.get('id1')::uuid; v_proto text; v_tok text;
begin
  select protocol, tracking_token into v_proto, v_tok from public.requests where id = v_id;
  update public.requests set protocol = 'CON-9999-9999', tracking_token = repeat('f', 48), created_at = now() - interval '5 years' where id = v_id;
  perform tests.ok((select protocol = v_proto and tracking_token = v_tok and created_at > now() - interval '1 day' from public.requests where id = v_id), 'protocolo, token e created_at são imutáveis');
  perform tests.ok((select count(distinct protocol) = count(*) from public.requests), 'protocolos únicos');
  perform tests.ok((select count(*) from public.requests where status is null) = 0, 'sem status nulo');
end $t$;

\echo
\echo '=== SUÍTE DE BANCO: TODOS OS TESTES PASSARAM ==='
