import { useMemo, useState } from "react";
import { importRequests } from "../../lib/api";
import { FIELDS, FIELD_LABEL, REQUIRED, buildRows, detectColumns, parseCsv, type BuildResult, type Field } from "../../lib/importer";
import { errMsg } from "../../lib/format";
import { Banner } from "../../components/ui";
import type { ImportResult } from "../../lib/types";

export default function ImportPage() {
  const [table, setTable] = useState<string[][] | null>(null);
  const [fileName, setFileName] = useState("");
  const [map, setMap] = useState<Record<Field, number> | null>(null);
  const [built, setBuilt] = useState<BuildResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const headers = table?.[0] ?? [];
  const missing = useMemo(() => (map ? REQUIRED.filter((f) => map[f] < 0) : []), [map]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setError(null); setResult(null); setBuilt(null);
    try {
      if (f.size > 10 * 1024 * 1024) throw new Error("O arquivo passa de 10 MB.");
      const t = parseCsv(await f.text());
      if (t.length < 2) throw new Error("Não encontrei linhas de dados. Exporte a planilha como CSV (Arquivo → Fazer download → .csv).");
      setTable(t);
      setFileName(f.name);
      const m = detectColumns(t[0]);
      setMap(m);
      setBuilt(await buildRows(t, m));
    } catch (e) {
      setTable(null); setMap(null);
      setError(errMsg(e));
    }
  }

  async function changeMap(field: Field, idx: number) {
    if (!map || !table) return;
    const m = { ...map, [field]: idx };
    setMap(m);
    setResult(null);
    setBuilt(await buildRows(table, m));
  }

  async function run() {
    if (!built || built.rows.length === 0) return;
    setBusy(true); setError(null); setResult(null);
    const total: ImportResult = { inserted: 0, skipped: 0, errors: [] };
    try {
      const size = 100;
      for (let i = 0; i < built.rows.length; i += size) {
        setProgress(`Importando ${Math.min(i + size, built.rows.length)} de ${built.rows.length}…`);
        const r = await importRequests(built.rows.slice(i, i + size));
        total.inserted += r.inserted;
        total.skipped += r.skipped;
        total.errors.push(...r.errors.map((e) => ({ row: e.row + i, reason: e.reason })));
      }
      setResult(total);
    } catch (e) {
      setError(`${errMsg(e)} O que já foi importado foi mantido; rode de novo para continuar (linhas repetidas são ignoradas).`);
    } finally {
      setBusy(false); setProgress("");
    }
  }

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Importar planilha antiga</h1>
        <p className="muted">Traga as respostas do Google Forms/Planilhas para o Conceive. Exporte a planilha como CSV e envie aqui. Repetir a importação do mesmo arquivo não duplica nada.</p>
      </header>

      <section className="card">
        <label className="label" htmlFor="csv">Arquivo CSV</label>
        <input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        {fileName && <p className="hint">{fileName} · {Math.max(0, (table?.length ?? 1) - 1)} linhas de dados</p>}
      </section>

      {error && <Banner>{error}</Banner>}

      {table && map && (
        <section className="card stack">
          <h2>1. Confira as colunas</h2>
          <p className="muted">Reconheci as colunas automaticamente. Ajuste se algo estiver errado. Campos com * são obrigatórios.</p>
          <div className="grid3">
            {FIELDS.map((f) => (
              <label key={f} className="field">
                <span className="label">{FIELD_LABEL[f]}{REQUIRED.includes(f) ? " *" : ""}</span>
                <select className="input" value={map[f]} onChange={(e) => void changeMap(f, Number(e.target.value))} aria-label={`Coluna para ${FIELD_LABEL[f]}`}>
                  <option value={-1}>— não importar —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `(coluna ${i + 1})`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {missing.length > 0 && <Banner>Faltam colunas obrigatórias: {missing.map((f) => FIELD_LABEL[f]).join(", ")}.</Banner>}
        </section>
      )}

      {built && (
        <section className="card stack">
          <h2>2. Prévia</h2>
          <p><strong>{built.rows.length}</strong> prontas para importar · <strong>{built.issues.length}</strong> com problema{built.duplicatesInFile > 0 && <> · {built.duplicatesInFile} repetidas no arquivo (ignoradas)</>}</p>
          {built.rows.length > 0 && (
            <div className="table-wrap"><table className="table static">
              <thead><tr><th>Data</th><th>Clínica</th><th>Solicitante</th><th>Módulo</th><th>Título</th><th>Status</th></tr></thead>
              <tbody>{built.rows.slice(0, 5).map((r) => (
                <tr key={r.key} className="static"><td className="nowrap">{r.created_at?.slice(0, 10) ?? "—"}</td><td>{r.clinic}</td><td>{r.name}</td><td>{r.module}</td><td>{r.title}</td><td>{r.status}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {built.issues.length > 0 && (
            <details>
              <summary>Ver linhas com problema ({built.issues.length}) — não serão importadas</summary>
              <ul className="issues">{built.issues.slice(0, 100).map((i) => <li key={i.line}>Linha {i.line}: {i.reason}</li>)}</ul>
            </details>
          )}
          <p className="hint">Telefones ausentes ou inválidos entram como “sem telefone” e recebem a tag <code>telefone-invalido</code>. Clínicas que não existem no cadastro entram como “novo vínculo” para você vincular depois.</p>
          <div className="row">
            <button className="btn btn-primary" disabled={busy || missing.length > 0 || built.rows.length === 0} onClick={() => void run()}>
              {busy ? progress : `Importar ${built.rows.length} solicitações`}
            </button>
          </div>
        </section>
      )}

      {result && (
        <Banner kind={result.errors.length ? "info" : "ok"}>
          Importação concluída: <strong>{result.inserted}</strong> criadas, <strong>{result.skipped}</strong> ignoradas (já existiam ou foram recusadas pelo banco).
          {result.errors.length > 0 && <ul className="issues">{result.errors.slice(0, 20).map((e, i) => <li key={i}>Linha {e.row + 2}: {e.reason}</li>)}</ul>}
        </Banner>
      )}
    </div>
  );
}
