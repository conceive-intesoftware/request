import { Icon } from "../components/Icon";
import { useCallback, useEffect, useState } from "react";
import { listPublicRequests, unvoteRequest, voteRequest } from "../lib/api";
import { MODULES, STATUSES, TYPES, labelOf } from "../lib/labels";
import { errMsg, fmtDate } from "../lib/format";
import { Banner, Select, Spinner } from "../components/ui";
import { PublicShell } from "../components/PublicShell";
import { useEnsureSession } from "../components/useEnsureSession";
import type { PublicList, PublicRow } from "../lib/types";

/** Roadmap público: pedidos que a equipe publicou. Clientes podem apoiar ("Também preciso disso"). */
export default function Comunidade() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [module, setModule] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PublicList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { ensure, captcha } = useEnsureSession();

  const load = useCallback(async () => {
    try {
      setData(await listPublicRequests(search, module, page));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [search, module, page]);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(r: PublicRow) {
    setBusyId(r.id);
    setError(null);
    try {
      if (!(await ensure())) return;
      if (r.voted_by_me) await unvoteRequest(r.id);
      else await voteRequest(r.id);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <PublicShell title="Roadmap e votação" subtitle="Veja o que a equipe está avaliando e construindo. Se um pedido também é importante para a sua clínica, apoie com um clique.">
      <main className="page narrow">
        <form className="filters pub-filters" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
          <input className="input" placeholder="Digite o que você procura" aria-label="Buscar no roadmap" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select ariaLabel="Módulo" value={module} onChange={(v) => { setPage(1); setModule(v); }} options={MODULES} placeholder="Módulo: todos" />
          <button className="btn" type="submit"><Icon name="search" size={16} /> Buscar</button>
        </form>

        {captcha}
        {error && <Banner>{error}</Banner>}
        {!data && !error && <Spinner />}
        {data && data.rows.length === 0 && (
          <div className="card"><p className="muted">Nenhum pedido publicado {search || module ? "com esses filtros" : "por enquanto"}. Quando a equipe publicar pedidos no roadmap, eles aparecem aqui.</p></div>
        )}

        <ul className="pub-list">
          {data?.rows.map((r) => (
            <li key={r.id} className="card pub-item">
              <div className="pub-main">
                <p className="small muted"><span className="mono">{r.protocol}</span> · {labelOf(MODULES, r.module)} · {labelOf(TYPES, r.type)} · {fmtDate(r.created_at)}</p>
                <h2>{r.title}</h2>
                <p className="muted pre">{r.excerpt}{r.excerpt.length >= 280 ? "…" : ""}</p>
                <p><span className="tag outline">{labelOf(STATUSES, r.status)}</span></p>
              </div>
              <div className="pub-vote">
                <p className="votes" aria-label={`${r.votes} ${r.votes === 1 ? "apoio" : "apoios"}`}><strong>{r.votes}</strong><span>{r.votes === 1 ? "apoio" : "apoios"}</span></p>
                {r.mine ? (
                  <span className="hint">Seu pedido</span>
                ) : (
                  <button className={r.voted_by_me ? "btn btn-voted" : "btn btn-primary"} disabled={busyId === r.id} aria-pressed={r.voted_by_me} onClick={() => void toggle(r)}>
                    {r.voted_by_me ? <><Icon name="check" size={15} /> Você apoia</> : <><Icon name="arrow-up" size={15} /> Também preciso disso</>}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        {data && pages > 1 && (
          <nav className="pager" aria-label="Paginação">
            <span className="muted">Página {data.page} de {pages}</span>
            <div className="row">
              <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
              <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
            </div>
          </nav>
        )}
      </main>
    </PublicShell>
  );
}
