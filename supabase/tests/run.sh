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
AUX="${DB}_aux"

fresh() {
  $DROPDB --if-exists "$1" >/dev/null 2>&1 || true
  $CREATEDB "$1"
}
run_strict() { $PSQL -X -q -v ON_ERROR_STOP=1 -d "$1" -f "$2" >/dev/null 2>/tmp/conceive_err.$$ || { cat /tmp/conceive_err.$$ >&2; rm -f /tmp/conceive_err.$$; exit 1; }; rm -f /tmp/conceive_err.$$; }

fresh "$DB"
echo "→ mock do Supabase";                 run_strict "$DB" supabase/tests/mock_supabase.sql
echo "→ migração (1ª vez)";                run_strict "$DB" supabase/migrations/20261121000000_init.sql
echo "→ migração (2ª vez: idempotência)";  run_strict "$DB" supabase/migrations/20261121000000_init.sql
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

fresh "$AUX"
echo "→ scripts auxiliares (admin, clínicas, limpeza)"
run_strict "$AUX" supabase/tests/mock_supabase.sql
run_strict "$AUX" supabase/migrations/20261121000000_init.sql
run_suite "$AUX" supabase/tests/scripts_auxiliares.sql "SCRIPTS AUXILIARES: OK" "scripts auxiliares"

$DROPDB --if-exists "$AUX" >/dev/null 2>&1 || true
echo "✔ todos os testes de banco passaram"
