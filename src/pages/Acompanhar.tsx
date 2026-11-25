import { Icon } from "../components/Icon";
import { useEffect, useState, type FormEvent } from "react";
import { addClientComment, getTracking, rateRequest } from "../lib/api";
import { STATUSES, MODULES, TYPES, labelOf } from "../lib/labels";
import { errMsg, extractToken, fmtDateTime } from "../lib/format";
import { Link, navigate } from "../lib/router";
import { PublicShell } from "../components/PublicShell";
import { Banner, Spinner } from "../components/ui";
import { AttachmentPicker } from "../components/AttachmentPicker";
import { StarRating } from "../components/StarRating";
import { useEnsureSession } from "../components/useEnsureSession";
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
          <input id="track-link" className="input" value={val} onChange={(e) => { setVal(e.target.value); setErr(null); }} placeholder="Cole aqui o link de acompanhamento" autoComplete="off" />
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn-primary" type="submit"><Icon name="search" size={16} /> Acompanhar</button>
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

  const refresh = () => getTracking(token).then(setData).catch((e) => setError(errMsg(e)));

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
              <li key={c.id} className={c.from_client ? "from-client" : ""}>
                <p className="pre">{c.body}</p>
                <p className="muted small">{fmtDateTime(c.created_at)} · {c.from_client ? "Você" : "Equipe Conceive"}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.status === "CONCLUIDO" && <Rating token={token} score={data.csat_score} comment={data.csat_comment} onSaved={() => void refresh()} />}
      {data.status !== "ARQUIVADO" && <Reply token={token} onSent={() => void refresh()} />}
    </main>
  );
}

function Reply({ token, onSent }: { token: string; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const { ensure, captcha } = useEnsureSession();

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return setErr("Escreva a sua resposta antes de enviar.");
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      if (!(await ensure())) return;
      await addClientComment(token, body.trim(), files, (n, t) => setProgress(`Enviando anexo ${n} de ${t}…`));
      setBody("");
      setFiles([]);
      setOk(true);
      onSent();
    } catch (e2) {
      setErr(errMsg(e2));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <section className="card">
      <h2>Enviar uma resposta</h2>
      <p className="muted">Precisa complementar o pedido ou responder à equipe? Escreva abaixo; anexe um print, se ajudar.</p>
      <form className="stack" onSubmit={(e) => void send(e)} noValidate>
        <label className="label" htmlFor="reply">Sua resposta</label>
        <textarea id="reply" className="input" rows={4} maxLength={4000} placeholder="Escreva a sua resposta aqui…" value={body} onChange={(e) => { setBody(e.target.value); setOk(false); }} />
        <AttachmentPicker files={files} onChange={setFiles} disabled={busy} inputId="reply-files" />
        {captcha}
        {err && <Banner>{err}</Banner>}
        {ok && <Banner kind="ok">Resposta enviada. Obrigado!</Banner>}
        <button className="btn btn-primary" disabled={busy}>{busy ? (progress ?? "Enviando…") : <><Icon name="message" size={16} /> Enviar resposta</>}</button>
      </form>
    </section>
  );
}

function Rating({ token, score, comment, onSaved }: { token: string; score: number | null; comment: string | null; onSaved: () => void }) {
  const [value, setValue] = useState<number | null>(score);
  const [text, setText] = useState(comment ?? "");
  const [editing, setEditing] = useState(score === null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!value) return setErr("Escolha uma nota de 1 a 5.");
    setBusy(true);
    setErr(null);
    try {
      await rateRequest(token, value, text);
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card rating">
      <h2>Como foi o atendimento?</h2>
      {editing ? (
        <div className="stack">
          <p className="muted">Sua solicitação foi concluída. Dê uma nota de 1 a 5 e, se quiser, conte o que achou.</p>
          <StarRating value={value} onChange={setValue} disabled={busy} />
          <textarea className="input" rows={3} maxLength={1000} placeholder="Escreva o seu comentário aqui…" aria-label="Comentário da avaliação" value={text} onChange={(e) => setText(e.target.value)} />
          {err && <Banner>{err}</Banner>}
          <div className="row">
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Enviar avaliação</button>
            {score !== null && <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancelar</button>}
          </div>
        </div>
      ) : (
        <div className="stack">
          <StarRating value={score} onChange={() => undefined} disabled />
          <p>Obrigado pela sua avaliação! {comment && <span className="muted">“{comment}”</span>}</p>
          <button className="link" onClick={() => setEditing(true)}>Alterar avaliação</button>
        </div>
      )}
    </section>
  );
}
