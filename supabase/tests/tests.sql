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
  perform tests.ok(not has_function_privilege('anon', 'public.submit_request(uuid,uuid,text,text,public.requester_role,text,public.system_module,public.request_type,text,text,text[],text)', 'execute'), 'anon sem sessão NÃO envia solicitação');
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
  select count(*) into n from public.role_permissions where role = 'ADMIN';      perform tests.ok(n = 18, 'ADMIN tem 18 permissões');
  select count(*) into n from public.role_permissions where role = 'PO';         perform tests.ok(n = 15, 'PO tem 15 permissões');
  select count(*) into n from public.role_permissions where role = 'SUPPORT';    perform tests.ok(n = 7, 'SUPPORT tem 7 permissões');
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
  perform tests.ok((select not public and file_size_limit = 52428800 from storage.buckets where id = 'attachments'), 'bucket privado com limite de 50 MB');
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

-- ───────── 23. e-mail do solicitante (v2) ─────────
do $t$
declare v_c uuid := gen_random_uuid(); v_tok text; v_id uuid; j jsonb; v_exp text;
begin
  perform tests.login(v_c, 'aal1', true);
  perform tests.fails($$select * from public.submit_request(null,null,'Clínica Mail','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Pedido com e-mail inválido','Descrição suficientemente longa para validar.','{}','sem-arroba')$$, 'invalid_email', 'e-mail inválido é recusado');
  select s.tracking_token into v_tok from public.submit_request(null,null,'Clínica Mail','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Pedido com e-mail válido','Descrição suficientemente longa para validar.','{}','  Fulano.Tal@Clinica.COM.br ') s;
  perform tests.logout();
  select id into v_id from public.requests where tracking_token = v_tok;
  perform tests.set('id_mail', v_id::text); perform tests.set('tok_mail', v_tok);
  perform tests.ok((select requester_email = 'fulano.tal@clinica.com.br' from public.requests where id = v_id), 'e-mail guardado em minúsculas e sem espaços');

  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');   -- DEV: mascarado
  j := public.get_request_detail(v_id);
  perform tests.ok(j ->> 'requester_email' = 'f***@clinica.com.br', 'DEV vê o e-mail mascarado');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');   -- PO: completo
  j := public.get_request_detail(v_id);
  perform tests.ok(j ->> 'requester_email' = 'fulano.tal@clinica.com.br', 'PO vê o e-mail completo');
  select public.export_requests('{}'::jsonb)::text into v_exp;
  perform tests.logout();
  perform tests.ok(position('@' in v_exp) = 0 and position('fulano' in v_exp) = 0, 'exportação continua sem e-mail');
  perform tests.ok(public.get_request_by_token(v_tok) ->> 'has_email' = 'true' and (public.get_request_by_token(v_tok)::text !~ 'clinica\.com'), 'acompanhamento só informa que há e-mail, sem mostrá-lo');
end $t$;

-- ───────── 24. e-mails automáticos (pg_net) ─────────
do $t$
declare v_c uuid := gen_random_uuid(); v_tok text; v_id uuid; n int; b jsonb;
begin
  select count(*) into n from net.calls;
  perform tests.ok(n = 0, 'sem configuração, nenhum webhook é disparado (mesmo com pedidos já criados)');

  insert into private.app_settings values ('notify_url', 'https://exemplo.supabase.co/functions/v1/notify'), ('notify_secret', 'segredo-teste');

  perform tests.login(v_c, 'aal1', true);
  select s.tracking_token into v_tok from public.submit_request(null,null,'Clínica Aviso','Fulano de Tal','MEDICO','84998493000','AGENDA','NOVA_FUNCIONALIDADE','Pedido para notificar','Descrição suficientemente longa para validar.','{}','cliente@exemplo.com') s;
  perform tests.logout();
  select id into v_id from public.requests where tracking_token = v_tok;
  select body into b from net.calls order by id desc limit 1;
  perform tests.ok(b ->> 'event' = 'request_created' and b ->> 'client_email' = 'cliente@exemplo.com' and b ->> 'tracking_token' = v_tok and b ->> 'clinic_name' = 'Clínica Aviso', 'novo pedido dispara request_created com e-mail, token e clínica');
  perform tests.ok(b::text !~ 'Fulano' and b::text !~ '84998493000', 'payload não carrega nome nem telefone');
  perform tests.ok((select headers ->> 'x-webhook-secret' = 'segredo-teste' and url like '%/notify' from net.calls order by id desc limit 1), 'segredo vai no cabeçalho');

  select count(*) into n from net.calls;
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.set_request_status(v_id, 'EM_ANALISE_PRODUTO');
  perform tests.logout();
  select body into b from net.calls order by id desc limit 1;
  perform tests.ok((select count(*) = n + 1 from net.calls) and b ->> 'event' = 'status_changed' and b ->> 'status' = 'EM_ANALISE_PRODUTO' and b ->> 'previous_status' = 'RECEBIDO', 'mudança de status dispara status_changed');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.add_comment(v_id, 'nota interna não vai por e-mail', true);
  perform tests.logout();
  perform tests.ok((select count(*) = n + 1 from net.calls), 'comentário interno NÃO dispara e-mail');
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.add_comment(v_id, 'Resposta pública para o cliente', false);
  perform tests.logout();
  select body into b from net.calls order by id desc limit 1;
  perform tests.ok(b ->> 'event' = 'comment_public' and b ->> 'body' = 'Resposta pública para o cliente' and b ->> 'client_email' = 'cliente@exemplo.com', 'resposta pública dispara comment_public');

  perform tests.login(gen_random_uuid(), 'aal1', true);
  perform public.add_client_comment(v_tok, 'Resposta do cliente');
  perform tests.logout();
  select body into b from net.calls order by id desc limit 1;
  perform tests.ok(b ->> 'event' = 'client_reply' and b ->> 'body' = 'Resposta do cliente' and not (b ? 'client_email'), 'resposta do cliente dispara client_reply (só para a equipe)');

  -- pedido sem e-mail: equipe é avisada, cliente não recebe nada nas mudanças
  select count(*) into n from net.calls;
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.set_request_status(tests.get('id1')::uuid, 'APROVADO_ROADMAP');
  perform public.add_comment(tests.get('id1')::uuid, 'sem e-mail cadastrado', false);
  perform tests.logout();
  perform tests.ok((select count(*) = n from net.calls), 'sem e-mail do cliente, status e resposta pública não disparam envio');

  -- arquivar não dispara
  select count(*) into n from net.calls;
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.archive_request(v_id);
  perform tests.logout();
  perform tests.ok((select count(*) = n from net.calls), 'arquivar não dispara e-mail');
end $t$;

-- falha no pg_net nunca derruba o envio
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                         headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$ begin raise exception 'pg_net fora do ar'; end $$;
do $t$
declare v_r record;
begin
  select * into v_r from tests.mk('Pedido com pg_net quebrado', null, 'Clínica Qualquer');
  perform tests.ok(v_r.protocol is not null, 'falha no webhook não impede o envio do pedido');
end $t$;
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                         headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
delete from private.app_settings;

-- ───────── 25. roadmap público e votos ─────────
do $t$
declare r1 record; r2 record; r3 record; a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); j jsonb; n int; v_sub uuid := gen_random_uuid(); v_extra uuid;
begin
  select * into r1 from tests.mk('Pedido publicado no roadmap', null, 'Clínica Teste V2');
  select * into r2 from tests.mk('Pedido privado do cliente', null, 'Clínica Teste V2');
  select * into r3 from tests.mk('Pedido duplicado e mesclado', null, 'Clínica Teste V2');
  perform tests.set('pub1', r1.id::text); perform tests.set('pub2', r2.id::text);

  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');
  perform tests.fails(format('select public.set_request_public(%L, true)', r1.id), 'forbidden', 'DEV não publica');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');
  perform tests.fails(format('select public.set_request_public(%L, true)', r1.id), 'forbidden', 'Suporte não publica');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.set_request_public(r1.id, true);
  perform public.merge_request(r3.id, r1.id);
  perform tests.fails(format('select public.set_request_public(%L, true)', r3.id), 'invalid_publish', 'pedido mesclado não é publicado');
  perform tests.fails(format('select public.set_request_public(%L, true)', gen_random_uuid()), 'not_found', 'publicar id inexistente');
  perform tests.logout();

  perform tests.as_anon_role();    -- sem sessão nenhuma
  j := public.list_public_requests();
  perform tests.logout();
  perform tests.ok((j ->> 'total')::int = 1 and j -> 'rows' -> 0 ->> 'title' = 'Pedido publicado no roadmap', 'lista pública (sem login) mostra só o publicado');
  perform tests.ok(j::text !~ 'Maria Teste' and j::text !~ '84986109779' and not (j -> 'rows' -> 0 ? 'requester_name'), 'lista pública não vaza dados pessoais');
  perform tests.ok(j -> 'rows' -> 0 ->> 'voted_by_me' = 'false', 'sem sessão: voted_by_me=false');

  perform tests.as_anon_role();
  perform tests.fails(format('select public.vote_request(%L)', r1.id), 'permission denied', 'votar exige sessão (anon nem executa)');
  perform tests.logout();

  perform tests.login(a, 'aal1', true);
  perform tests.ok(public.vote_request(r1.id) = 1, 'primeiro voto = 1');
  perform tests.ok(public.vote_request(r1.id) = 1, 'votar de novo não duplica');
  perform tests.fails(format('select public.vote_request(%L)', r2.id), 'not_found', 'não vota em pedido não publicado');
  j := public.list_public_requests();
  perform tests.ok(j -> 'rows' -> 0 ->> 'voted_by_me' = 'true' and (j -> 'rows' -> 0 ->> 'votes')::int = 1, 'lista marca "voted_by_me" e conta 1');
  perform tests.logout();
  perform tests.login(b, 'aal1', true);
  perform tests.ok(public.vote_request(r1.id) = 2, 'segundo cliente: 2 votos');
  perform tests.ok(public.unvote_request(r1.id) = 1, 'retirar o voto volta para 1');
  perform tests.ok(public.unvote_request(r1.id) = 1, 'retirar de novo é inofensivo');
  perform tests.logout();

  -- o autor do pedido não vota no próprio
  select submitted_by into v_sub from public.requests where id = r1.id;
  perform tests.login(v_sub, 'aal1', true);
  perform tests.fails(format('select public.vote_request(%L)', r1.id), 'invalid_vote', 'autor não vota no próprio pedido');
  perform tests.logout();

  -- busca e filtro
  perform tests.as_anon_role();
  perform tests.ok((public.list_public_requests('roadmap') ->> 'total')::int = 1 and (public.list_public_requests('zzzz') ->> 'total')::int = 0, 'busca na lista pública');
  perform tests.ok((public.list_public_requests(null, 'FINANCEIRO') ->> 'total')::int = 0 and (public.list_public_requests(null, 'AGENDA') ->> 'total')::int = 1, 'filtro por módulo');
  perform tests.logout();

  -- limite de 60 votos por hora
  insert into public.requests (requester_name, requester_role, whatsapp_e164, pending_clinic_name, title, description, module, type, is_public)
  select 'Gerado ' || g, 'OUTRO', '+5584999990000', 'Clínica Massa', 'Pedido em massa ' || g, 'Descrição de teste em massa para votação.', 'OUTRO', 'MELHORIA_FLUXO', true
  from generate_series(1, 61) g;
  insert into public.request_votes (request_id, user_id)
  select id, 'b0000000-0000-0000-0000-0000000000ff' from public.requests where title like 'Pedido em massa %' order by title limit 60;
  v_extra := (select id from public.requests where is_public and title like 'Pedido em massa %'
                and id not in (select request_id from public.request_votes where user_id = 'b0000000-0000-0000-0000-0000000000ff') limit 1);
  perform tests.login('b0000000-0000-0000-0000-0000000000ff', 'aal1', true);
  perform tests.fails(format('select public.vote_request(%L)', v_extra), 'rate_limited', '61º voto na mesma hora é barrado');
  perform tests.logout();
  -- limpar o ruído para as próximas seções
  delete from public.request_votes where user_id = 'b0000000-0000-0000-0000-0000000000ff';
  update public.requests set is_public = false where title like 'Pedido em massa %';
  perform tests.ok((select count(*) from public.requests where is_public) = 1, 'apenas o pedido publicado segue público');
end $t$;

-- ───────── 26. resposta do cliente ─────────
do $t$
declare v_tok text := tests.get('tok_mail'); v_id uuid; r record; c uuid := gen_random_uuid(); j jsonb; v_path text; cid uuid; n int; i int;
begin
  select * into r from tests.mk('Pedido para respostas do cliente', null, 'Clínica Teste V2');
  v_tok := r.token; v_id := r.id; perform tests.set('rep_id', v_id::text); perform tests.set('rep_tok', v_tok);

  perform tests.as_anon_role();
  perform tests.fails(format('select public.add_client_comment(%L, %L)', v_tok, 'oi'), 'permission denied', 'responder exige sessão (anon nem executa)');
  perform tests.logout();
  perform tests.login(c, 'aal1', true);
  perform tests.fails(format('select public.add_client_comment(%L, %L)', repeat('0', 48), 'oi'), 'not_found', 'token inexistente');
  perform tests.fails(format('select public.add_client_comment(%L, %L)', 'abc', 'oi'), 'not_found', 'token malformado');
  perform tests.fails(format('select public.add_client_comment(%L, %L)', v_tok, '   '), 'invalid_comment', 'resposta vazia');
  perform tests.fails(format('select public.add_client_comment(%L, %L)', v_tok, repeat('x', 4001)), 'invalid_comment', 'resposta acima de 4000');
  cid := public.add_client_comment(v_tok, '  Segue mais detalhe do problema.  ');
  perform tests.ok(cid is not null, 'cliente responde com o token');
  perform tests.logout();

  j := public.get_request_by_token(v_tok);
  perform tests.ok(jsonb_array_length(j -> 'comments') = 1 and j -> 'comments' -> 0 ->> 'from_client' = 'true' and j -> 'comments' -> 0 ->> 'body' = 'Segue mais detalhe do problema.', 'resposta aparece no acompanhamento como "do cliente"');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.get_request_detail(v_id);
  perform tests.ok(j -> 'comments' -> 0 ->> 'author_kind' = 'CLIENT' and j -> 'comments' -> 0 -> 'author_name' = 'null'::jsonb, 'equipe vê a resposta marcada como CLIENT');
  j := public.list_requests(jsonb_build_object('q', r.protocol));
  perform tests.ok(j -> 'rows' -> 0 ->> 'awaiting_reply' = 'true', 'lista marca "aguardando resposta da equipe"');
  perform public.add_comment(v_id, 'Obrigado, estamos analisando.', false);
  j := public.list_requests(jsonb_build_object('q', r.protocol));
  perform tests.ok(j -> 'rows' -> 0 ->> 'awaiting_reply' = 'false', 'resposta pública da equipe limpa a marca');
  perform tests.logout();

  -- anexos na resposta
  v_path := c::text || '/' || gen_random_uuid() || '__print.png';
  insert into storage.objects (bucket_id, name, owner, metadata) values ('attachments', v_path, c, '{"mimetype":"image/png","size":1234}');
  perform tests.login(c, 'aal1', true);
  perform public.add_client_comment(v_tok, 'Com anexo', array[v_path]);
  perform tests.fails(format('select public.add_client_comment(%L, %L, %L::text[])', v_tok, 'reuso', array[v_path]), 'invalid_attachment', 'mesmo arquivo não é anexado duas vezes');
  perform tests.fails(format('select public.add_client_comment(%L, %L, %L::text[])', v_tok, 'de outro', array[gen_random_uuid()::text || '/x.png']), 'invalid_attachment', 'arquivo de outra pasta é recusado');
  perform tests.fails(format('select public.add_client_comment(%L, %L, %L::text[])', v_tok, 'inexistente', array[c::text || '/nao-existe.png']), 'invalid_attachment', 'arquivo que não existe no bucket');
  perform tests.logout();
  perform tests.ok((select count(*) = 1 from public.request_attachments where request_id = v_id and file_name = 'print.png'), 'anexo da resposta fica no pedido');

  -- limite de 5 respostas em 10 minutos
  perform tests.login(c, 'aal1', true);
  for i in 1..10 loop
    begin perform public.add_client_comment(v_tok, 'rajada ' || i); n := i; exception when others then exit; end;
  end loop;
  perform tests.fails(format('select public.add_client_comment(%L, %L)', v_tok, 'mais uma'), 'rate_limited', 'a 6ª é barrada');
  perform tests.logout();
  perform tests.ok((select count(*) from public.request_comments where request_id = v_id and author_kind = 'CLIENT' and created_at > now() - interval '10 minutes') = 5, 'no máximo 5 respostas do cliente em 10 minutos');

  -- pedido arquivado não aceita resposta
  select * into r from tests.mk('Pedido arquivado sem respostas', null, 'Clínica Teste V2');
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.archive_request(r.id);
  perform tests.logout();
  perform tests.login(gen_random_uuid(), 'aal1', true);
  perform tests.fails(format('select public.add_client_comment(%L, %L)', r.token, 'oi'), 'closed_request', 'arquivado não recebe resposta');
  perform tests.logout();
end $t$;

-- ───────── 27. pesquisa de satisfação (CSAT) ─────────
do $t$
declare r record; j jsonb;
begin
  select * into r from tests.mk('Pedido para avaliar', null, 'Clínica Teste V2');
  perform tests.as_anon_role();
  perform tests.fails(format('select public.rate_request(%L, 5)', r.token), 'not_rateable', 'não avalia antes de concluir');
  perform tests.logout();
  perform tests.ok((select completed_at is null from public.requests where id = r.id), 'completed_at vazio enquanto aberto');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.set_request_status(r.id, 'CONCLUIDO');
  perform tests.logout();
  perform tests.ok((select completed_at is not null from public.requests where id = r.id), 'completed_at preenchido ao concluir');

  perform tests.as_anon_role();
  perform tests.fails(format('select public.rate_request(%L, 0)', r.token), 'invalid_score', 'nota 0 inválida');
  perform tests.fails(format('select public.rate_request(%L, 6)', r.token), 'invalid_score', 'nota 6 inválida');
  perform tests.fails(format('select public.rate_request(%L, 5)', repeat('0', 48)), 'not_found', 'token inexistente');
  perform tests.fails(format('select public.rate_request(%L, 5, %L)', r.token, repeat('x', 1001)), 'invalid_comment', 'comentário > 1000');
  perform public.rate_request(r.token, 4, '  Bom, mas demorou  ');
  j := public.get_request_by_token(r.token);
  perform tests.logout();
  perform tests.ok((j ->> 'csat_score')::int = 4 and j ->> 'csat_comment' = 'Bom, mas demorou', 'avaliação aparece no acompanhamento (sem login)');
  perform tests.as_anon_role(); perform public.rate_request(r.token, 5); perform tests.logout();
  perform tests.ok((select csat_score = 5 and csat_comment is null from public.requests where id = r.id), 'cliente pode mudar a nota');

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  j := public.get_request_detail(r.id);
  perform tests.ok((j -> 'csat' ->> 'score')::int = 5, 'equipe vê a nota no detalhe');
  perform public.set_request_status(r.id, 'EM_DESENVOLVIMENTO');
  perform tests.logout();
  perform tests.ok((select completed_at is null from public.requests where id = r.id), 'reabrir limpa completed_at');
  perform tests.ok(exists (select 1 from public.audit_logs where entity = 'requests' and entity_id = r.id::text and new_value ->> 'csat_score' = '5'), 'avaliação foi auditada');
end $t$;

-- ───────── 28. métricas ─────────
do $t$
declare j jsonb; v_fr numeric;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000004', 'aal2');
  perform tests.fails('select public.get_metrics(90)', 'forbidden', 'DEV não vê métricas');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000005', 'aal2');
  perform tests.fails('select public.get_metrics(90)', 'forbidden', 'quem não é da equipe não vê métricas');
  perform tests.logout();
  perform tests.as_anon_role();
  perform tests.ok(not has_function_privilege('anon', 'public.get_metrics(int)', 'execute'), 'anon não executa get_metrics');
  perform tests.logout();

  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform public.set_request_status(tests.get('rep_id')::uuid, 'CONCLUIDO');
  perform tests.logout();
  perform tests.login('a0000000-0000-0000-0000-000000000003', 'aal2');   -- Suporte pode
  j := public.get_metrics(0);
  perform tests.logout();
  perform tests.ok((j ->> 'total')::int > 5 and (j ->> 'completed')::int >= 1 and (j ->> 'total')::int = (j ->> 'open')::int + (j ->> 'completed')::int, 'métricas: total = abertas + concluídas');
  perform tests.ok(jsonb_array_length(j -> 'weekly') = 12 and jsonb_array_length(j -> 'csat' -> 'distribution') = 5, 'métricas: 12 semanas e 5 notas');
  perform tests.ok((j -> 'csat' ->> 'count')::int >= 1 and (j -> 'csat' ->> 'avg')::numeric between 1 and 5, 'métricas: CSAT');
  perform tests.ok(j ->> 'avg_first_response_hours' is not null and (j ->> 'avg_first_response_hours')::numeric >= 0, 'métricas: tempo até a 1ª resposta');
  perform tests.ok(j::text !~ 'Maria Teste|Sarah|84986109779|@exemplo|@clinica', 'métricas não carregam dados pessoais');
  perform tests.ok((j -> 'top_voted') is not null and (j ->> 'votes_total')::int >= 0, 'métricas: votos');
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform tests.ok((public.get_metrics(1) ->> 'total')::int <= (public.get_metrics(0) ->> 'total')::int, 'filtro de período reduz (ou mantém) o total');
  perform tests.logout();
end $t$;

-- ───────── 29. importação da planilha antiga ─────────
do $t$
declare j jsonb; rows jsonb; n0 int; n_calls int; v_id uuid;
begin
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform tests.fails($$select public.admin_import_requests('[]'::jsonb)$$, 'forbidden', 'PO não importa');
  perform tests.logout();

  rows := jsonb_build_array(
    jsonb_build_object('key','k1','created_at','2025-03-10T14:30:00-03:00','clinic','KARDIÓMOV','unit','unidade 1','name','Sarah Silva','role','ADMINISTRADOR',
      'whatsapp','(84) 99849-3000','module','FINANCEIRO','type','MELHORIA_FLUXO','title','Pagamento antecipado de consulta','description','Texto antigo da planilha com tamanho suficiente.','status','CONCLUIDO','email','sarah@antiga.com'),
    jsonb_build_object('key','k2','created_at','2025-04-01T09:00:00-03:00','clinic','Clínica Que Não Existe','name','Renata Souza','role','FARMACEUTICO',
      'whatsapp','telefone ruim','module','ESTOQUE_FARMACIA','type','NOVA_FUNCIONALIDADE','title','Adicionar marcas ao produto','description','Solicito adicionar a opção de marca no cadastro de produto.'),
    jsonb_build_object('key','k3','clinic','Kardiomov','name','Fulano de Tal','role','MEDICO','whatsapp','84998493000','module','AGENDA','type','SUGESTAO_TECNICA','title','abc','description','Título curto demais para passar na validação.'),
    jsonb_build_object('key','k4','clinic','Kardiomov','name','Beltrano','role','PAPEL_INVENTADO','whatsapp','84998493000','module','AGENDA','type','SUGESTAO_TECNICA','title','Papel inexistente no banco','description','Valor de enum inválido deve virar erro da linha.'),
    jsonb_build_object('key','k5','created_at','2999-01-01T00:00:00Z','clinic','Kardiomov','name','Ciclano','role','OUTRO','whatsapp','84998493000','module','OUTRO','type','NOVA_FUNCIONALIDADE','title','Data no futuro vira agora','description','A data futura deve ser limitada ao momento atual.')
  );
  select count(*) into n0 from public.requests;
  select count(*) into n_calls from net.calls;
  insert into private.app_settings values ('notify_url', 'https://exemplo/notify'), ('notify_secret', 's');

  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal2');
  j := public.admin_import_requests(rows);
  perform tests.logout();
  perform tests.ok((j ->> 'inserted')::int = 3 and (j ->> 'skipped')::int = 2 and jsonb_array_length(j -> 'errors') = 2, 'importa 3 e rejeita 2 (título curto e enum inválido)');
  perform tests.ok(j -> 'errors' @> '[{"row":2}]'::jsonb and j -> 'errors' @> '[{"row":3}]'::jsonb, 'erros apontam a linha (base 0) de cada falha');
  perform tests.ok((select count(*) = n0 + 3 from public.requests), '3 solicitações novas');
  perform tests.ok((select count(*) = n_calls from net.calls), 'importação NÃO dispara e-mails');
  delete from private.app_settings;

  select id into v_id from public.requests where import_key = 'k1';
  perform tests.ok((select origin = 'IMPORT' and status = 'CONCLUIDO' and created_at = '2025-03-10T14:30:00-03:00'::timestamptz and completed_at is not null and clinic_id = 'c0000000-0000-0000-0000-000000000001' and unit_id = 'd0000000-0000-0000-0000-000000000001' and requester_email = 'sarah@antiga.com' from public.requests where id = v_id), 'linha 1: clínica e unidade casadas sem acento/caixa, data e status preservados');
  perform tests.ok((select clinic_id is null and pending_clinic_name = 'Clínica Que Não Existe' and whatsapp_e164 = '+5500000000000' from public.requests where import_key = 'k2'), 'linha 2: clínica nova vira pendente; telefone ruim vira marcador');
  perform tests.ok(exists (select 1 from public.request_tags rt join public.tags t on t.id = rt.tag_id join public.requests r on r.id = rt.request_id where r.import_key = 'k2' and t.name = 'telefone-invalido'), 'linha 2 recebe a tag telefone-invalido');
  perform tests.ok((select created_at <= now() from public.requests where import_key = 'k5'), 'data no futuro é limitada a agora');
  perform tests.ok((select count(distinct protocol) = count(*) from public.requests), 'protocolos continuam únicos');

  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal2');
  j := public.admin_import_requests(rows);
  perform tests.ok((j ->> 'inserted')::int = 0 and (j ->> 'skipped')::int = 5, 'repetir o mesmo lote não duplica');
  perform tests.fails(format('select public.admin_import_requests(%L::jsonb)', (select jsonb_agg(jsonb_build_object('key', g)) from generate_series(1, 201) g)), 'too_many_rows', 'lote acima de 200 linhas é recusado');
  perform tests.fails($$select public.admin_import_requests('{"a":1}'::jsonb)$$, 'invalid_input', 'entrada que não é lista');
  perform tests.logout();
  perform tests.ok(exists (select 1 from public.audit_logs where entity = 'import_batch' and (new_value ->> 'inserted')::int = 3), 'lote importado foi auditado');
  perform tests.ok((select count(*) from public.audit_logs where entity = 'requests' and action = 'CREATE' and new_value ->> 'origin' = 'IMPORT') = 3, 'cada linha importada tem CREATE na trilha');
end $t$;

-- ───────── 24b. registro das tentativas de e-mail ─────────
do $t$
declare j jsonb;
begin
  perform tests.ok((select count(*) > 0 from private.notify_log where outcome = 'ENFILEIRADO' and net_id is not null), 'tentativas aceitas pelo pg_net ficam registradas');
  perform tests.ok((select count(*) = 1 from private.notify_log where outcome = 'ERRO' and detail like '%pg_net fora do ar%'), 'falha do pg_net fica registrada com o motivo (e não derruba o pedido)');
  perform tests.ok((select count(*) = 0 from private.notify_log where coalesce(detail, '') ~ '@' or event ~ '@' or coalesce(protocol, '') ~ '@'), 'o registro não guarda e-mail de ninguém');
  insert into net._http_response (id, status_code, error_msg) select max(net_id), 401, null from private.notify_log where outcome = 'ENFILEIRADO';
  perform tests.login('a0000000-0000-0000-0000-000000000001', 'aal2');
  j := public.admin_notify_log(500);
  perform tests.logout();
  perform tests.ok(jsonb_array_length(j) >= 2 and (j -> 0 ->> 'id')::bigint > (j -> 1 ->> 'id')::bigint, 'Admin lê o registro, do mais novo para o mais antigo');
  perform tests.ok(exists (select 1 from jsonb_array_elements(j) e where e ->> 'http_status' = '401'), 'o status HTTP da função aparece junto (quando o pg_net o guarda)');
  perform tests.login('a0000000-0000-0000-0000-000000000002', 'aal2');
  perform tests.fails($$select public.admin_notify_log(10)$$, 'forbidden', 'PO não lê o registro de e-mails');
  perform tests.logout();
  perform tests.ok(not has_table_privilege('authenticated', 'private.notify_log', 'select') and not has_function_privilege('anon', 'public.admin_notify_log(int)', 'execute'), 'registro fechado para anon e authenticated');
end $t$;

-- ───────── 24c. SLA: sem resposta / paradas ─────────
do $t$
declare a record; b record; c record; d record; v_r public.requests; j jsonb; n int; v_before int; v_body jsonb;
  v_po uuid := 'a0000000-0000-0000-0000-000000000002';
begin
  select * into a from tests.mk('SLA pedido sem resposta', null, 'Clínica SLA');
  select * into b from tests.mk('SLA pedido em análise parado', null, 'Clínica SLA');
  select * into c from tests.mk('SLA pedido cliente respondeu', null, 'Clínica SLA');
  select * into d from tests.mk('SLA pedido em dia', null, 'Clínica SLA');

  select * into v_r from public.requests where id = a.id;
  perform tests.ok(private.sla_state(v_r) is null, 'pedido novo não está atrasado');

  set local session_replication_role = replica;   -- permite "voltar no tempo" (os gatilhos de imutabilidade ficam de fora)
  update public.requests set created_at = now() - interval '4 days' where id = a.id;
  update public.requests set status = 'EM_ANALISE_PRODUTO', created_at = now() - interval '40 days', updated_at = now() - interval '20 days' where id = b.id;
  update public.requests set created_at = now() - interval '10 days' where id = c.id;
  set local session_replication_role = origin;

  perform tests.ok(private.sla_state((select r from public.requests r where r.id = a.id)) = 'SEM_RESPOSTA', 'Recebido há 4 dias sem resposta da equipe = SEM_RESPOSTA');
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = b.id)) = 'PARADA', 'Em análise sem movimento há 20 dias = PARADA');
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = d.id)) is null, 'pedido recente continua em dia');

  -- resposta da equipe resolve o primeiro caso e o segundo
  perform tests.login(v_po, 'aal2');
  perform public.add_comment(a.id, 'Já estamos olhando.', false);
  perform public.add_comment(b.id, 'Nota interna de acompanhamento.', true);
  perform tests.logout();
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = a.id)) is null, 'resposta pública da equipe tira do SEM_RESPOSTA');
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = b.id)) is null, 'qualquer comentário da equipe conta como movimento (sai de PARADA)');

  -- cliente respondeu por último há mais de 3 dias
  perform tests.login(v_po, 'aal2');
  perform public.add_comment(c.id, 'Pode detalhar?', false);
  perform tests.logout();
  perform tests.login(gen_random_uuid(), 'aal1', true);
  perform public.add_client_comment(c.token, 'Segue o detalhe pedido.');
  perform tests.logout();
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = c.id)) is null, 'resposta recente do cliente ainda está no prazo');
  update public.request_comments set created_at = now() - interval '6 days' where request_id = c.id and author_kind = 'STAFF';
  update public.request_comments set created_at = now() - interval '5 days' where request_id = c.id and author_kind = 'CLIENT';
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = c.id)) = 'SEM_RESPOSTA', 'cliente respondeu há 5 dias e a equipe não voltou = SEM_RESPOSTA');

  -- exclusões
  set local session_replication_role = replica;
  update public.requests set status = 'CONCLUIDO' where id = c.id;
  set local session_replication_role = origin;
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = c.id)) is null, 'concluída nunca é atrasada');

  -- prazo configurável
  update public.requests set status = 'RECEBIDO' where id = a.id;   -- (já tem resposta da equipe)
  delete from public.request_comments where request_id = a.id;
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = a.id)) = 'SEM_RESPOSTA', 'sem resposta de novo (prazo padrão de 3 dias)');
  insert into private.app_settings values ('sla_first_days', '10');
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = a.id)) is null, 'prazo configurável: com 10 dias, 4 dias ainda está em dia');
  delete from private.app_settings where key = 'sla_first_days';

  -- volta o pedido B ao estado "parado" para os testes de lista, filtro e resumo
  delete from public.request_comments where request_id = b.id;
  set local session_replication_role = replica;
  update public.requests set updated_at = now() - interval '20 days' where id = b.id;
  set local session_replication_role = origin;
  perform tests.ok(private.sla_state((select r from public.requests r where r.id = b.id)) = 'PARADA', 'sem movimento de novo = PARADA');

  -- lista, filtro e métricas
  perform tests.login(v_po, 'aal2');
  j := public.list_requests('{"sla":"stalled"}'::jsonb, 1, 200);
  perform tests.ok((select bool_and(e ->> 'sla' is not null) from jsonb_array_elements(j -> 'rows') e) and (j ->> 'total')::int >= 2, 'filtro "paradas" devolve só pedidos com SLA vencido');
  perform tests.ok(exists (select 1 from jsonb_array_elements(j -> 'rows') e where e ->> 'protocol' = a.protocol and e ->> 'sla' = 'SEM_RESPOSTA'), 'a linha traz o motivo (SEM_RESPOSTA)');
  perform tests.ok(not exists (select 1 from jsonb_array_elements(j -> 'rows') e where e ->> 'protocol' = d.protocol), 'pedido em dia fica de fora do filtro');
  perform tests.ok((select (e ->> 'sla') is null from jsonb_array_elements(public.list_requests('{}'::jsonb, 1, 200) -> 'rows') e where e ->> 'protocol' = d.protocol), 'sem filtro, pedido em dia vem com sla nulo');
  perform tests.ok((public.get_metrics(0) ->> 'stalled')::int = (j ->> 'total')::int, 'métrica "stalled" bate com o filtro');
  perform tests.logout();

  -- resumo diário
  select count(*) into v_before from net.calls;
  n := private.send_sla_digest();
  perform tests.ok(n >= 2 and (select count(*) = v_before from net.calls), 'sem e-mail configurado, o resumo não chama a função (e não dá erro)');
  insert into private.app_settings values ('notify_url', 'https://exemplo/notify'), ('notify_secret', 's');
  select count(*) into v_before from net.calls;
  n := private.send_sla_digest();
  select c2.body into v_body from net.calls c2 order by id desc limit 1;
  perform tests.ok(n >= 2 and (select count(*) = v_before + 1 from net.calls) and v_body ->> 'event' = 'sla_digest' and (v_body ->> 'count')::int = n, 'resumo diário dispara 1 evento com a contagem');
  perform tests.ok(jsonb_array_length(v_body -> 'items') = least(n, 30) and v_body::text !~ 'Maria Teste' and v_body::text !~ '84986109779', 'itens do resumo limitados a 30 e sem dados pessoais');
  perform tests.ok(exists (select 1 from jsonb_array_elements(v_body -> 'items') e where e ->> 'protocol' = a.protocol), 'resumo lista o pedido atrasado');
  delete from private.app_settings;
end $t$;

-- ───────── 30. privilégios das novidades ─────────
do $t$
begin
  perform tests.ok(has_function_privilege('anon', 'public.list_public_requests(text,public.system_module,int)', 'execute'), 'anon lê o roadmap público');
  perform tests.ok(has_function_privilege('anon', 'public.rate_request(text,int,text)', 'execute'), 'anon avalia pelo token');
  perform tests.ok(not has_function_privilege('anon', 'public.vote_request(uuid)', 'execute') and not has_function_privilege('anon', 'public.add_client_comment(text,text,text[])', 'execute'), 'anon não vota nem responde (precisa de sessão)');
  perform tests.ok(not has_function_privilege('anon', 'public.admin_import_requests(jsonb)', 'execute') and not has_function_privilege('anon', 'public.set_request_public(uuid,boolean)', 'execute'), 'anon não importa nem publica');
  perform tests.ok(not has_table_privilege('authenticated', 'private.app_settings', 'select') and not has_table_privilege('anon', 'private.app_settings', 'select'), 'configurações internas fechadas');
  perform tests.ok(not has_table_privilege('authenticated', 'public.request_votes', 'select') and not has_table_privilege('anon', 'public.request_votes', 'insert'), 'votos só por RPC');
  perform tests.ok(not has_function_privilege('authenticated', 'private.notify_event(jsonb)', 'execute'), 'notify_event não é chamável pelo cliente');
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
