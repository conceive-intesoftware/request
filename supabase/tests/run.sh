#!/usr/bin/env bash
# Roda a migração + testes de banco num Postgres LOCAL (descartável). NUNCA aponte para o seu projeto Supabase!
#
# Uso (Postgres local com usuário superuser; as variáveis PG* do psql são respeitadas):
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres npm run test:db
# Opcional: PSQL / CREATEDB / DROPDB para trocar os comandos (ex.: "runuser -u postgres -- psql").
set -euo pipefail
cd "$(dirname "$0")/../.."

PSQL="${PSQL:-psql}"; CREATEDB="${CREATEDB:-createdb}"; DROPDB="${DROPDB:-dropdb}"
DB="${TEST_DB:-conceive_test}"

fresh() {
  $DROPDB --if-exists "$1" >/dev/null 2>&1 || true
  $CREATEDB "$1"
}
run_strict() { $PSQL -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" >/dev/null 2>/tmp/conceive_err.$$ || { cat /tmp/conceive_err.$$ >&2; rm -f /tmp/conceive_err.$$; exit 1; }; rm -f /tmp/conceive_err.$$; }

fresh "$DB"
echo "→ mock do Supabase";                 run_strict "$DB" supabase/tests/mock_supabase.sql
echo "→ Supabase-completo.sql (1ª vez)";       run_strict "$DB" supabase/Supabase-completo.sql
echo "→ Supabase-completo.sql (2ª vez: idempotência)"; run_strict "$DB" supabase/Supabase-completo.sql
# Executa um arquivo de testes e só aprova se: psql saiu com sucesso, imprimiu a frase final e rodou ao menos 1 verificação.
run_suite() { # $1=banco  $2=arquivo  $3=frase final esperada  $4=rótulo
  local out; out="$(mktemp)"
  if ! $PSQL -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" >"$out" 2>&1; then
    cat "$out" >&2; rm -f "$out"; echo "✗ $4 FALHARAM" >&2; exit 1
  fi
  local n; n="$(grep -c 'NOTICE:  ok' "$out" || true)"
  if ! grep -q "$3" "$out" || [ "$n" -lt 1 ]; then
    cat "$out" >&2; rm -f "$out"; echo "✗ $4: saída inesperada (os testes não rodaram de verdade)" >&2; exit 1
  fi
  echo "  $n verificações passaram"; rm -f "$out"
}

echo "→ testes de banco"
run_suite "$DB" supabase/tests/tests.sql "TODOS OS TESTES PASSARAM" "testes de banco"

CMP="${DB}_completo"
fresh "$CMP"
echo "→ Supabase-completo.sql com a Parte B ligada (admin, clínicas, e-mails, limpeza agora)"
run_strict "$CMP" supabase/tests/mock_supabase.sql

$PSQL -X -q -d "$CMP" -c "insert into auth.users (id, email) values ('a0000000-0000-0000-0000-0000000000bb', 'Chefe@Empresa.com')" >/dev/null
TMPC="$(mktemp --suffix=.sql)"
sed -e "s|v_admin_email   text    := null;|v_admin_email   text    := 'chefe@empresa.com';|" \
    -e "s|v_clinicas      boolean := false;|v_clinicas      boolean := true;|" \
    -e "s|v_notify_url    text    := null;|v_notify_url    text    := 'https://x.supabase.co/functions/v1/notify';|" \
    -e "s|v_notify_secret text    := null;|v_notify_secret text    := 'segredo-longo-e-aleatorio-com-32-caracteres-ou-mais';|" \
    -e "s|v_limpar_agora  boolean := false;|v_limpar_agora  boolean := true;|" supabase/Supabase-completo.sql > "$TMPC"
chmod a+r "$TMPC"
run_strict "$CMP" "$TMPC"   # 1ª vez cria o bucket do Storage
$PSQL -X -q -d "$CMP" >/dev/null <<'SQL'
insert into auth.users (id, email, is_anonymous, created_at) values
  ('b0000000-0000-0000-0000-000000000001', null, true,  now() - interval '40 days'),
  ('b0000000-0000-0000-0000-000000000002', null, true,  now() - interval '5 days'),
  ('b0000000-0000-0000-0000-000000000003', null, true,  now() - interval '40 days'),
  ('b0000000-0000-0000-0000-000000000004', 'staff@x.com', false, now() - interval '400 days');
insert into storage.objects (bucket_id, name, owner, metadata) values ('attachments', 'x/x.png', 'b0000000-0000-0000-0000-000000000003', '{}');
SQL
run_strict "$CMP" "$TMPC"   # 2ª vez (idempotência + limpeza agora)
rm -f "$TMPC"
chk() { [ "$($PSQL -X -At -d "$CMP" -c "$1")" = "$2" ] || { echo "✗ Supabase-completo: esperado '$2' em: $1" >&2; exit 1; }; }
chk "select role from public.profiles where email = 'chefe@empresa.com'" "ADMIN"
chk "select count(*) from public.clinics" "4"
chk "select count(*) from auth.users where id::text like 'b0000000%'" "3"
chk "select count(*) from auth.users where id = 'b0000000-0000-0000-0000-000000000001'" "0"
chk "select count(*) from private.app_settings where key in ('notify_url','notify_secret')" "2"
$DROPDB --if-exists "$CMP" >/dev/null 2>&1 || true
echo "✔ todos os testes de banco passaram"
