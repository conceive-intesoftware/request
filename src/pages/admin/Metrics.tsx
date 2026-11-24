import { useEffect, useState } from "react";
import { getMetrics } from "../../lib/api";
import { MODULES, STATUSES, TYPES, labelOf } from "../../lib/labels";
import { errMsg } from "../../lib/format";
import { Banner, Spinner } from "../../components/ui";
import type { Metrics as M } from "../../lib/types";

const fmtNum = (n: number | null | undefined, unit = "") => (n === null || n === undefined ? "—" : `${String(n).replace(".", ",")}${unit}`);
const fmtHours = (h: number | null) => (h === null ? "—" : h >= 48 ? `${fmtNum(Math.round(h / 24 * 10) / 10)} dias` : `${fmtNum(h)} h`);

function Bars({ items, label }: { items: { name: string; count: number }[]; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <p className="muted">Sem dados no período.</p>;
  return (
    <ul className="bars" aria-label={label}>
      {items.map((i) => (
        <li key={i.name}>
          <span className="bar-name">{i.name}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(i.count / max) * 100}%` }} /></span>
          <span className="bar-n">{i.count}</span>
        </li>
      ))}
    </ul>
  );
}

function Weekly({ weeks }: { weeks: M["weekly"] }) {
  const max = Math.max(1, ...weeks.flatMap((w) => [w.created, w.completed]));
  return (
    <div className="weekly" role="img" aria-label={`Solicitações por semana: ${weeks.map((w) => `${w.week}: ${w.created} criadas, ${w.completed} concluídas`).join("; ")}`}>
      {weeks.map((w) => (
        <div key={w.week} className="wk">
          <div className="wk-bars">
            <span className="wk-bar created" style={{ height: `${(w.created / max) * 100}%` }} title={`${w.created} criadas`} />
            <span className="wk-bar done" style={{ height: `${(w.completed / max) * 100}%` }} title={`${w.completed} concluídas`} />
          </div>
          <span className="wk-label">{w.week.slice(8, 10)}/{w.week.slice(5, 7)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Metrics() {
  const [days, setDays] = useState(90);
  const [m, setM] = useState<M | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setM(null);
    setError(null);
    getMetrics(days).then((d) => alive && setM(d)).catch((e) => alive && setError(errMsg(e)));
    return () => { alive = false; };
  }, [days]);

  return (
    <div>
      <header className="page-head row between">
        <div>
          <h1>Métricas</h1>
          <p className="muted">Indicadores de atendimento e de demanda. Sem dados pessoais.</p>
        </div>
        <label className="row" htmlFor="period"><span className="label">Período</span>
          <select id="period" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option>
            <option value={365}>Últimos 12 meses</option><option value={0}>Todo o período</option>
          </select>
        </label>
      </header>

      {error && <Banner>{error}</Banner>}
      {!m && !error && <Spinner />}
      {m && (
        <div className="stack">
          <section className="kpis" aria-label="Indicadores principais">
            <div className="kpi"><span>Solicitações</span><strong>{m.total}</strong></div>
            <div className="kpi"><span>Em aberto</span><strong>{m.open}</strong></div>
            <div className="kpi"><span>Concluídas</span><strong>{m.completed}</strong><small>{fmtNum(m.completion_rate, "%")} do total</small></div>
            <div className="kpi"><span>Aguardando a equipe</span><strong>{m.awaiting_reply}</strong><small>cliente respondeu por último</small></div>
            <div className="kpi"><span>Paradas ou sem resposta</span><strong>{m.stalled}</strong><small>além do prazo (3 dias / 15 dias)</small></div>
            <div className="kpi"><span>1ª resposta (média)</span><strong>{fmtHours(m.avg_first_response_hours)}</strong></div>
            <div className="kpi"><span>Tempo até concluir (média)</span><strong>{m.avg_resolution_days === null ? "—" : `${fmtNum(m.avg_resolution_days)} dias`}</strong></div>
            <div className="kpi"><span>Satisfação</span><strong>{m.csat.avg === null ? "—" : `${fmtNum(m.csat.avg)} / 5`}</strong><small>{m.csat.count} {m.csat.count === 1 ? "avaliação" : "avaliações"}</small></div>
            <div className="kpi"><span>Apoios no roadmap</span><strong>{m.votes_total}</strong></div>
          </section>

          <section className="card">
            <h2>Últimas 12 semanas</h2>
            <p className="legend"><span className="dot-c" /> criadas <span className="dot-d" /> concluídas</p>
            <Weekly weeks={m.weekly} />
          </section>

          <div className="grid2">
            <section className="card"><h2>Por status</h2><Bars label="Por status" items={m.by_status.map((x) => ({ name: labelOf(STATUSES, x.key), count: x.count }))} /></section>
            <section className="card"><h2>Por módulo</h2><Bars label="Por módulo" items={m.by_module.map((x) => ({ name: labelOf(MODULES, x.key), count: x.count }))} /></section>
            <section className="card"><h2>Por tipo de demanda</h2><Bars label="Por tipo" items={m.by_type.map((x) => ({ name: labelOf(TYPES, x.key), count: x.count }))} /></section>
            <section className="card"><h2>Clínicas que mais pedem</h2><Bars label="Clínicas" items={m.top_clinics} /></section>
            <section className="card"><h2>Notas de satisfação</h2>
              <Bars label="Notas" items={[...m.csat.distribution].reverse().map((x) => ({ name: `${x.score} ${"★".repeat(x.score)}`, count: x.count }))} /></section>
            <section className="card"><h2>Mais apoiados</h2>
              {m.top_voted.length === 0 ? <p className="muted">Nenhum apoio ainda.</p> : (
                <ol className="top-voted">{m.top_voted.map((t) => <li key={t.protocol}><span className="mono small">{t.protocol}</span> {t.title} <strong>{t.votes}</strong></li>)}</ol>
              )}</section>
          </div>
        </div>
      )}
    </div>
  );
}
