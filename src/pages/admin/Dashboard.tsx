import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../lib/api";
import type { Ctx, Filters, ListResult } from "../../lib/types";
import { MODULES, PRIORITIES, REQUESTER_ROLES, STATUSES, labelOf } from "../../lib/labels";
import { EXPORT_COLUMNS, downloadCsv, toCsv } from "../../lib/csv";
import { errMsg, fmtDate } from "../../lib/format";
import { Banner, Select, Spinner } from "../../components/ui";
import { RequestDetail } from "./RequestDetail";
import { Kanban } from "./Kanban";

const PAGE_SIZE = 25;

export default function Dashboard({ ctx }: { ctx: Ctx }) {
  const can = (p: string) => ctx.permissions.includes(p);
  const [view, setView] = useState<"list" | "kanban">("list");
  const [filters, setFilters] = useState<Filters>({});
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [clinics, setClinics] = useState<{ id: string; name: string }[]>([]);
  const seq = useRef(0);

  const size = view === "kanban" ? 200 : PAGE_SIZE;

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api.listRequests(filters, view === "kanban" ? 1 : page, size);
      if (my === seq.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(errMsg(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [filters, page, size, view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api.listClinicsAdmin().then((c) => setClinics(c.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined);
  }, []);

  const setF = (k: keyof Filters, v: string) => {
    setPage(1);
    setFilters((p) => ({ ...p, [k]: v }));
  };

  async function onExport() {
    try {
      const rows = await api.exportRequests(filters);
      if (rows.length === 0) return alert("Nada para exportar com estes filtros.");
      downloadCsv(`solicitacoes-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, EXPORT_COLUMNS));
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function onMove(id: string, status: string) {
    try {
      await api.setStatus(id, status);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div>
      <header className="page-head row between">
        <div>
          <h1>Solicitações</h1>
          <p className="muted">{data ? `${data.total} resultado(s)` : "…"} · perfil <strong>{ctx.role}</strong></p>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Visualização">
            <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>Lista</button>
            <button className={view === "kanban" ? "on" : ""} onClick={() => setView("kanban")}>Kanban</button>
          </div>
          {can("report:export") && <button className="btn" onClick={() => void onExport()}>Exportar CSV</button>}
        </div>
      </header>

      <form className="filters" onSubmit={(e) => { e.preventDefault(); setF("q", q.trim()); }}>
        <input className="input" placeholder="Buscar por título, protocolo ou solicitante…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
        <Select ariaLabel="Clínica" value={filters.clinic_id ?? ""} onChange={(v) => setF("clinic_id", v)} options={clinics.map((c) => [c.id, c.name] as const)} placeholder="Clínica: todas" />
        <Select ariaLabel="Cargo" value={filters.requester_role ?? ""} onChange={(v) => setF("requester_role", v)} options={REQUESTER_ROLES} placeholder="Cargo: todos" />
        <Select ariaLabel="Módulo" value={filters.module ?? ""} onChange={(v) => setF("module", v)} options={MODULES} placeholder="Módulo: todos" />
        <Select ariaLabel="Status" value={filters.status ?? ""} onChange={(v) => setF("status", v)} options={STATUSES.filter(([k]) => k !== "ARQUIVADO")} placeholder="Status: todos" />
        <Select ariaLabel="Prioridade" value={filters.priority ?? ""} onChange={(v) => setF("priority", v)} options={PRIORITIES} placeholder="Prioridade: todas" />
        <input className="input" type="date" aria-label="De" value={filters.from ?? ""} onChange={(e) => setF("from", e.target.value)} />
        <input className="input" type="date" aria-label="Até" value={filters.to ?? ""} onChange={(e) => setF("to", e.target.value)} />
        <button type="submit" className="btn">Buscar</button>
        <button type="button" className="btn btn-ghost" onClick={() => { setFilters({}); setQ(""); setPage(1); }}>Limpar</button>
      </form>

      {error && <Banner>{error}</Banner>}
      {loading && !data && <Spinner />}

      {data && view === "list" && (
        <>
          <div className="table-wrap" aria-busy={loading}>
            <table className="table">
              <thead>
                <tr><th>Protocolo</th><th>Título</th><th>Clínica</th><th>Solicitante</th><th>Módulo</th><th>Status</th><th>Prioridade</th><th className="num">RICE</th><th>Data</th></tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={9} className="empty">Nenhuma solicitação encontrada.</td></tr>}
                {data.rows.map((r) => (
                  <tr key={r.id} tabIndex={0} onClick={() => setOpenId(r.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(r.id)}>
                    <td className="mono small">{r.protocol}</td>
                    <td className="title-cell">
                      <strong>{r.title}</strong>
                      {r.duplicates_count > 0 && <span className="tag">+{r.duplicates_count} similar(es)</span>}
                      {r.merged_into_id && <span className="tag outline">mesclada</span>}
                    </td>
                    <td>{r.clinic_name ?? <span className="warn" title="Clínica ainda não vinculada">{r.pending_clinic_name} (novo)</span>}</td>
                    <td><div className={r.pii_masked ? "mono small" : ""}>{r.requester_name}</div><div className="muted small">{labelOf(REQUESTER_ROLES, r.requester_role)}</div></td>
                    <td>{labelOf(MODULES, r.module)}</td>
                    <td><span className="tag outline">{labelOf(STATUSES, r.status)}</span></td>
                    <td><span className={`tag prio-${r.priority}`}>{labelOf(PRIORITIES, r.priority)}</span></td>
                    <td className="num">{r.rice_score ?? "—"}</td>
                    <td className="nowrap">{fmtDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Paginação">
            <span className="muted">Página {data.page} de {pages}</span>
            <div className="row">
              <button className="btn" disabled={data.page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
              <button className="btn" disabled={data.page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
            </div>
          </nav>
        </>
      )}

      {data && view === "kanban" && (
        <>
          {data.total > data.rows.length && <Banner kind="info">Mostrando {data.rows.length} de {data.total}. Refine os filtros para ver o restante.</Banner>}
          <Kanban rows={data.rows} canMove={can("request:update_status")} onOpen={setOpenId} onMove={onMove} />
        </>
      )}

      {openId && <RequestDetail id={openId} ctx={ctx} clinics={clinics} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </div>
  );
}
