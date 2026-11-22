import { useEffect, useState } from "react";
import { getTracking } from "../lib/api";
import { STATUSES, MODULES, TYPES, labelOf } from "../lib/labels";
import { errMsg, fmtDateTime } from "../lib/format";
import { Link } from "../lib/router";
import { Banner, Spinner } from "../components/ui";
import type { Tracking } from "../lib/types";

export default function Acompanhar({ token }: { token: string }) {
  const [data, setData] = useState<Tracking | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError(null);
    getTracking(token)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [token]);

  if (error) {
    return (
      <main className="page narrow">
        <Banner>{error}</Banner>
      </main>
    );
  }
  if (data === undefined) {
    return (
      <main className="page narrow">
        <Spinner />
      </main>
    );
  }
  if (data === null) {
    return (
      <main className="page narrow">
        <div className="card">
          <h1>Solicitação não encontrada</h1>
          <p className="muted">Confira se o link foi copiado por inteiro.</p>
          <Link to="/solicitar" className="btn">Fazer uma nova solicitação</Link>
        </div>
      </main>
    );
  }

  const flow = STATUSES.filter(([k]) => k !== "ARQUIVADO");
  const idx = flow.findIndex(([k]) => k === data.status);

  return (
    <main className="page narrow">
      <p className="mono muted">{data.protocol}</p>
      <h1>{data.title}</h1>
      <p className="muted">
        {labelOf(MODULES, data.module)} · {labelOf(TYPES, data.type)} · enviada em {fmtDateTime(data.created_at)} · atualizada em {fmtDateTime(data.updated_at)}
      </p>

      {data.status === "ARQUIVADO" ? (
        <Banner kind="info">Esta solicitação foi arquivada.</Banner>
      ) : (
        <ol className="steps" aria-label="Andamento">
          {flow.map(([k, label], i) => (
            <li key={k} className={i < idx ? "done" : i === idx ? "current" : ""} aria-current={i === idx ? "step" : undefined}>
              <span className="bullet">{i < idx ? "✓" : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}

      <section className="card">
        <h2>Respostas da equipe</h2>
        {data.comments.length === 0 ? (
          <p className="muted">Ainda não há respostas.</p>
        ) : (
          <ul className="thread">
            {data.comments.map((c) => (
              <li key={c.id}>
                <p className="pre">{c.body}</p>
                <p className="muted small">{fmtDateTime(c.created_at)} · Equipe ConceIve</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted small"><Link to="/solicitar">← Nova solicitação</Link></p>
    </main>
  );
}
