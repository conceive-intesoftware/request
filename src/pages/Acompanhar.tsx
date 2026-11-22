import { useEffect, useState } from "react";
import { getTracking } from "../lib/api";
import { STATUSES, MODULES, TYPES, labelOf } from "../lib/labels";
import { errMsg, extractToken, fmtDateTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { PublicShell } from "../components/PublicShell";
import { Banner, Spinner } from "../components/ui";
import type { Tracking } from "../lib/types";

export default function Acompanhar({ token }: { token?: string }) {
  return (
    <PublicShell title="Acompanhar sua solicitação" subtitle="Veja em que etapa está o seu pedido e leia as respostas da nossa equipe.">
      {token ? <Detail token={token} /> : <Busca />}
    </PublicShell>
  );
}

function Busca() {
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="page narrow">
      <section className="card">
        <h2>Localize sua solicitação</h2>
        <p className="muted">Cole o link de acompanhamento que você recebeu ao enviar o pedido.</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const t = extractToken(val);
            if (!t) return setErr("Link inválido. Cole o link completo recebido após o envio.");
            navigate(`/acompanhar/${t}`);
          }}
        >
          <label className="label" htmlFor="track-link">Link de acompanhamento</label>
          <input id="track-link" className="input" value={val} onChange={(e) => { setVal(e.target.value); setErr(null); }} placeholder="https://…#/acompanhar/…" autoComplete="off" />
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn-primary" type="submit">Acompanhar</button>
        </form>
      </section>
      <section className="card">
        <h2>Perdeu o link?</h2>
        <p className="muted">
          Por segurança, o protocolo (ex.: CON-2026-0088) sozinho não dá acesso ao andamento. Fale com a nossa equipe informando o protocolo e o nome da clínica, e reenviaremos o link.
        </p>
      </section>
    </main>
  );
}

function Detail({ token }: { token: string }) {
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
          <h2>Solicitação não encontrada</h2>
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
      <h2 className="req-title">{data.title}</h2>
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
                <p className="muted small">{fmtDateTime(c.created_at)} · Equipe Conceive</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
