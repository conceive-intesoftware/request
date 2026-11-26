import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as api from "../../lib/api";
import type { Ctx, Detail } from "../../lib/types";
import { MODULES, PRIORITIES, REQUESTER_ROLES, STAFF_ROLES, STATUSES, TYPES, labelOf } from "../../lib/labels";
import { errMsg, fmtBytes, fmtDateTime } from "../../lib/format";
import { formatPhoneBR, maskPhoneInput, whatsappLink } from "../../lib/phone";
import { Banner, Field, Modal, Select, Spinner } from "../../components/ui";
import { AttachmentPicker } from "../../components/AttachmentPicker";
import { Icon, type IconName } from "../../components/Icon";
import { AuditTrail } from "./AuditTrail";

type Tab = "detalhes" | "priorizacao" | "comentarios" | "auditoria";

export function RequestDetail({
  id,
  ctx,
  clinics,
  onClose,
  onChanged,
}: {
  id: string;
  ctx: Ctx;
  clinics: { id: string; name: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>("detalhes");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can = (p: string) => ctx.permissions.includes(p);

  const load = useCallback(async () => {
    try {
      setD(await api.getRequestDetail(id));
    } catch (e) {
      setError(errMsg(e));
      setD(null);
    }
  }, [id]);

  useEffect(() => {
    setD(undefined);
    setTab("detalhes");
    void load();
  }, [load]);

  /** Executa uma ação, recarrega o detalhe e avisa a lista. */
  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
      await load();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={d?.title ?? "Solicitação"} subtitle={d?.protocol} onClose={onClose}>
      {error && <Banner>{error}</Banner>}
      {d === undefined && <Spinner />}
      {d === null && !error && <Banner kind="info">Solicitação não encontrada (pode ter sido arquivada).</Banner>}
      {d && (
        <>
          <nav className="tabs" role="tablist">
            {(["detalhes", "priorizacao", "comentarios", ...(d.audit ? ["auditoria"] : [])] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                <Icon name={({ detalhes: "clipboard", priorizacao: "sliders", comentarios: "message", auditoria: "history" } as Record<Tab, IconName>)[t]} size={15} />
                {{ detalhes: "Detalhes", priorizacao: "Priorização", comentarios: `Comentários (${d.comments.length})`, auditoria: "Auditoria" }[t]}
              </button>
            ))}
          </nav>

          {tab === "detalhes" && <Details d={d} can={can} busy={busy} run={run} clinics={clinics} onClose={onClose} />}
          {tab === "priorizacao" && <Prioritization d={d} can={can} busy={busy} run={run} />}
          {tab === "comentarios" && <Comments d={d} can={can} busy={busy} run={run} />}
          {tab === "auditoria" && d.audit && <AuditTrail entries={d.audit} />}
        </>
      )}
    </Modal>
  );
}

type Run = (fn: () => Promise<unknown>, after?: () => void) => Promise<void>;
type Common = { d: Detail; can: (p: string) => boolean; busy: boolean; run: Run };

const isImage = (mime: string) => mime.startsWith("image/");

/** Miniatura (imagens) ou etiqueta (outros arquivos). A URL assinada é pedida só quando o item aparece. */
function FileChip({ a }: { key?: string; a: { file_name: string; mime_type: string; size_bytes: number; storage_path: string } }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (isImage(a.mime_type)) api.signedAttachmentUrl(a.storage_path).then((u) => alive && setUrl(u)).catch(() => undefined);
    return () => { alive = false; };
  }, [a.storage_path, a.mime_type]);
  async function open() {
    try { window.open(url ?? (await api.signedAttachmentUrl(a.storage_path)), "_blank", "noopener,noreferrer"); } catch (e) { alert(errMsg(e)); }
  }
  if (isImage(a.mime_type)) {
    return (
      <figure className="fig">
        <button type="button" className="thumb" onClick={() => void open()} title={`${a.file_name} (${fmtBytes(a.size_bytes)})`} aria-label={`Abrir imagem ${a.file_name}`}>
          {url ? <img src={url} alt="" loading="lazy" /> : <span className="thumb-ph"><Icon name="image" size={22} /></span>}
        </button>
        <figcaption>{a.file_name}</figcaption>
      </figure>
    );
  }
  return (
    <button type="button" className="file-chip" onClick={() => void open()}>
      <Icon name="paperclip" size={14} /> <span>{a.file_name}</span> <small>{fmtBytes(a.size_bytes)}</small>
    </button>
  );
}

function Section({ icon, title, children, aside }: { icon: IconName; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="dsec">
      <header className="dsec-h"><h3><Icon name={icon} size={16} className="h-ic" />{title}</h3>{aside}</header>
      {children}
    </section>
  );
}

function Details({ d, can, busy, run, clinics, onClose }: Common & { clinics: { id: string; name: string }[]; onClose: () => void }) {
  const [mergeProto, setMergeProto] = useState("");
  const [linkId, setLinkId] = useState("");
  const [ext, setExt] = useState({ system: d.external_system ?? "", id: d.external_id ?? "" });
  const [tags, setTags] = useState(d.tags.join(", "));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setExt({ system: d.external_system ?? "", id: d.external_id ?? "" }); }, [d.external_system, d.external_id]);

  async function doMerge(e: FormEvent) {
    e.preventDefault();
    const proto = mergeProto.trim().toUpperCase();
    if (!proto) return;
    const found = await api.listRequests({ q: proto }, 1, 5);
    const target = found.rows.find((r) => r.protocol === proto);
    if (!target) return alert("Protocolo não encontrado.");
    await run(() => api.mergeRequest(d.id, target.id), () => setMergeProto(""));
  }

  if (editing) return <EditForm d={d} can={can} busy={busy} run={run} onCancel={() => setEditing(false)} />;

  return (
    <div className="dstack">
      <div className="dtop">
        <div className="dtop-status">
          <label className="label" htmlFor="st">Status</label>
          <Select id="st" value={d.status} disabled={!can("request:update_status") || busy} onChange={(s) => void run(() => api.setStatus(d.id, s))} options={STATUSES} />
          {!can("request:update_status") && <p className="hint">Seu perfil não pode alterar o status.</p>}
        </div>
        <div className="dtop-chips">
          <span className={`tag prio-${d.priority}`}>Prioridade {labelOf(PRIORITIES, d.priority).toLowerCase()}</span>
          <span className="tag outline" title="Pontuação RICE">Pontuação {d.rice.score ?? "—"}</span>
          {d.is_public && <span className="tag outline"><Icon name="globe" size={11} />no roadmap</span>}
          {d.votes > 0 && <span className="tag outline"><Icon name="arrow-up" size={11} />{d.votes}</span>}
        </div>
        {can("request:edit") && <button className="btn btn-sm" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Editar dados da solicitação</button>}
      </div>

      {d.merged_into && <Banner kind="info">Esta solicitação foi mesclada em <strong className="mono">{d.merged_into.protocol}</strong>.
        {can("request:merge") && <> <button className="link" disabled={busy} onClick={() => void run(() => api.unmergeRequest(d.id))}>desfazer</button></>}</Banner>}

      <Section icon="clipboard" title="Pedido">
        <p className="pre dtext">{d.description}</p>
        <dl className="meta">
          <div><dt>Módulo</dt><dd>{labelOf(MODULES, d.module)}</dd></div>
          <div><dt>Tipo de demanda</dt><dd>{labelOf(TYPES, d.type)}</dd></div>
          <div><dt>Enviada em</dt><dd>{fmtDateTime(d.created_at)}{d.origin === "IMPORT" ? " · importada" : ""}</dd></div>
          {d.csat?.score != null && <div><dt>Satisfação</dt><dd>{"★".repeat(d.csat.score)}{"☆".repeat(5 - d.csat.score)} ({d.csat.score}/5){d.csat.comment ? <> — <span className="pre">{d.csat.comment}</span></> : null}</dd></div>}
        </dl>
        {d.attachments.length > 0 && (
          <div className="dfiles"><span className="label">Anexos do pedido</span><div className="thumbs">{d.attachments.map((a) => <FileChip key={a.id} a={a} />)}</div></div>
        )}
      </Section>

      <div className="dcols">
        <Section icon="user" title="Solicitante">
          <p className="dname">{d.requester_name} {d.pii_masked && <span className="tag outline">mascarado (LGPD)</span>}</p>
          <p className="muted small">{labelOf(REQUESTER_ROLES, d.requester_role)}</p>
          <ul className="contact">
            <li><Icon name="phone" size={15} />{d.pii_masked ? d.whatsapp : (
              <a href={whatsappLink(d.whatsapp, `Olá! Sobre sua solicitação ${d.protocol} no Conceive…`)} target="_blank" rel="noopener noreferrer">{formatPhoneBR(d.whatsapp)}</a>)}</li>
            {d.requester_email && <li><Icon name="mail" size={15} />{d.pii_masked ? d.requester_email : <a href={`mailto:${d.requester_email}`}>{d.requester_email}</a>}</li>}
          </ul>
        </Section>
        <Section icon="building" title="Clínica">
          <p className="dname">{d.clinic_name ?? <span className="warn">{d.pending_clinic_name}</span>}</p>
          <p className="muted small">{d.clinic_name ? (d.unit_name ?? "Sem unidade informada") : "Ainda não vinculada a uma clínica cadastrada"}</p>
          {!d.clinic_id && can("request:link_clinic") && (
            <div className="row">
              <Select value={linkId} onChange={setLinkId} options={clinics.map((c) => [c.id, c.name] as const)} placeholder="Vincular a uma clínica…" ariaLabel="Clínica" />
              <button className="btn btn-sm" disabled={busy || !linkId} onClick={() => void run(() => api.linkClinic(d.id, linkId, null))}><Icon name="link" size={15} /> Vincular</button>
            </div>
          )}
        </Section>
      </div>

      {d.duplicates.length > 0 && (
        <Section icon="merge" title={`Pedidos semelhantes (${d.duplicates.length})`}>
          <ul className="files">
            {d.duplicates.map((x) => (
              <li key={x.id}>
                <span><span className="mono">{x.protocol}</span> — {x.title} <small className="muted">({x.clinic_name ?? "sem clínica"})</small></span>
                {can("request:merge") && <button className="link danger" disabled={busy} onClick={() => void run(() => api.unmergeRequest(x.id))}>desfazer</button>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(can("request:publish") || can("request:export_dev") || can("request:prioritize") || d.tags.length > 0) && (
        <Section icon="sliders" title="Gestão">
          {can("request:publish") && (
            <label className="check"><input type="checkbox" checked={d.is_public} disabled={busy} onChange={(e) => {
              const on = e.target.checked;
              if (on && !confirm("Publicar no roadmap? O título e a descrição ficarão visíveis a qualquer pessoa, sem nome nem contato do solicitante. Confira se não há dados de pacientes.")) return;
              void run(() => api.setRequestPublic(d.id, on));
            }} /> Mostrar no roadmap público (permite votos)</label>
          )}
          {can("request:export_dev") && (
            <div className="field">
              <span className="label">Tarefa no sistema de desenvolvimento</span>
              <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setExternalRef(d.id, ext.system, ext.id)); }}>
                <Select value={ext.system} onChange={(s) => setExt({ ...ext, system: s })} options={[["REDMINE", "Redmine"], ["PIPEFY", "Pipefy"]]} placeholder="Sistema" ariaLabel="Sistema externo" />
                <input className="input" placeholder="ID da tarefa" value={ext.id} maxLength={80} onChange={(e) => setExt({ ...ext, id: e.target.value })} aria-label="ID externo" />
                <button className="btn" disabled={busy}><Icon name="save" size={15} /> Salvar vínculo</button>
              </form>
              {d.external_id && (
                <div className="row">
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(async () => {
                    await api.adminSyncExternalNow();
                    alert("Leitura pedida. Em alguns segundos o status da tarefa é consultado e, se mudou, a etapa desta solicitação é atualizada (atualize a página para ver).");
                  })}><Icon name="refresh" size={14} /> Sincronizar status agora</button>
                </div>
              )}
              {!d.external_id && (
                <div className="row">
                  {(["REDMINE", "PIPEFY"] as const).map((sys) => (
                    <button key={sys} className="btn btn-sm" disabled={busy} onClick={() => void run(async () => {
                      const r = await api.createExternalTask(d.id, sys);
                      if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
                    })}><Icon name="external" size={14} /> Criar tarefa no {sys === "REDMINE" ? "Redmine" : "Pipefy"}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          {can("request:prioritize") ? (
            <form className="field" onSubmit={(e) => { e.preventDefault(); void run(() => api.setTags(d.id, tags.split(",").map((t) => t.trim()).filter(Boolean))); }}>
              <label className="label" htmlFor="tags">Etiquetas</label>
              <div className="row">
                <input id="tags" className="input" placeholder="Ex.: agenda, convênio (separe por vírgula)" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
                <button className="btn" disabled={busy}><Icon name="tag" size={15} /> Salvar tags</button>
              </div>
            </form>
          ) : d.tags.length > 0 && <p>{d.tags.map((t) => <span key={t} className="tag outline">{t}</span>)}</p>}
        </Section>
      )}

      {((can("request:merge") && !d.merged_into) || can("request:archive")) && (
        <details className="dmore">
          <summary><Icon name="chevron-right" size={15} className="dm-ic" /> Mais ações</summary>
          <div className="stack">
            {can("request:merge") && !d.merged_into && (
              <form className="row" onSubmit={(e) => void doMerge(e)}>
                <input className="input" placeholder="Protocolo da solicitação principal (ex.: CON-2026-0001)" value={mergeProto} onChange={(e) => setMergeProto(e.target.value)} aria-label="Protocolo para mesclar" />
                <button className="btn" disabled={busy || !mergeProto.trim()}><Icon name="merge" size={15} /> Mesclar nesta</button>
              </form>
            )}
            {can("request:archive") && (
              <div><button className="btn btn-danger" disabled={busy} onClick={() => { if (confirm("Arquivar esta solicitação? Ela não é excluída, apenas ocultada.")) void run(() => api.archiveRequest(d.id), onClose); }}>
                <Icon name="archive" size={15} /> Arquivar solicitação
              </button></div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/** Opções em linguagem simples. Por baixo, o banco continua calculando a pontuação RICE. */
const IMPACT: readonly (readonly [string, string, string])[] = [
  ["0.5", "Baixo", "melhora pequena, poucas pessoas notam"],
  ["1", "Médio", "melhora clara no dia a dia"],
  ["2", "Alto", "muda bem o fluxo de trabalho"],
  ["3", "Muito alto", "resolve um problema crítico"],
];
const EFFORT: readonly (readonly [string, string, string])[] = [
  ["0.5", "Pequeno", "até 2 semanas de uma pessoa"],
  ["1", "Médio", "cerca de 1 mês"],
  ["3", "Grande", "cerca de 3 meses"],
  ["6", "Muito grande", "6 meses ou mais"],
];
const CONFIDENCE: readonly (readonly [string, string, string])[] = [
  ["0.5", "Baixa", "ainda há muitas dúvidas"],
  ["0.8", "Média", "entendemos bem o pedido"],
  ["1", "Alta", "pedido claro e validado"],
];
const nearest = (opts: readonly (readonly [string, string, string])[], v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "";
  return opts.reduce((best, o) => (Math.abs(Number(o[0]) - Number(v)) < Math.abs(Number(best[0]) - Number(v)) ? o : best))[0];
};

function Choice({ legend, name, opts, value, onChange, disabled }: { legend: string; name: string; opts: readonly (readonly [string, string, string])[]; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <fieldset className="choice" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="choice-opts">
        {opts.map(([v, l, hint]) => (
          <label key={v} className={value === v ? "on" : ""}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
            <strong>{l}</strong><small>{hint}</small>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Prioritization({ d, can, busy, run }: Common) {
  const [f, setF] = useState({
    priority: d.priority,
    reach: String(d.rice.reach ?? 1),
    impact: nearest(IMPACT, d.rice.impact),
    confidence: nearest(CONFIDENCE, d.rice.confidence),
    effort: nearest(EFFORT, d.rice.effort),
  });
  const allowed = can("request:prioritize");
  const ready = f.impact !== "" && f.confidence !== "" && f.effort !== "" && Number(f.reach) >= 1;
  const live = ready ? Math.round(((Number(f.reach) * Number(f.impact) * Number(f.confidence)) / Number(f.effort)) * 100) / 100 : null;

  return (
    <form className="dstack" onSubmit={(e) => { e.preventDefault(); if (ready) void run(() => api.setPriority(d.id, f.priority, Number(f.reach), Number(f.impact), Number(f.confidence), Number(f.effort))); }}>
      <Section icon="alert" title="Prioridade">
        <div className="field">
          <label className="label" htmlFor="pr">Quão urgente é este pedido?</label>
          <Select id="pr" value={f.priority} disabled={!allowed} onChange={(v) => setF({ ...f, priority: v })} options={PRIORITIES} />
        </div>
      </Section>
      <Section icon="chart" title="Importância para o produto" aside={<span className="score" aria-live="polite"><small>Pontuação</small><strong>{live ?? d.rice.score ?? "—"}</strong></span>}>
        <p className="hint">Responda com base no que você sabe hoje. A pontuação sobe com mais clínicas e impacto, e desce com mais esforço.</p>
        <div className="field">
          <label className="label" htmlFor="re">Quantas clínicas ou usuários serão beneficiados?</label>
          <input id="re" className="input narrow-in" type="number" min={1} step={1} required disabled={!allowed} value={f.reach} onChange={(e) => setF({ ...f, reach: e.target.value })} />
        </div>
        <Choice legend="Impacto para quem usa" name="impact" opts={IMPACT} value={f.impact} onChange={(v) => setF({ ...f, impact: v })} disabled={!allowed} />
        <Choice legend="Esforço de desenvolvimento" name="effort" opts={EFFORT} value={f.effort} onChange={(v) => setF({ ...f, effort: v })} disabled={!allowed} />
        <Choice legend="Confiança na estimativa" name="confidence" opts={CONFIDENCE} value={f.confidence} onChange={(v) => setF({ ...f, confidence: v })} disabled={!allowed} />
      </Section>
      {allowed
        ? <button className="btn btn-primary" disabled={busy || !ready}><Icon name="save" size={16} /> Salvar priorização</button>
        : <p className="hint">Seu perfil só pode visualizar.</p>}
      {d.votes > 0 && <p className="hint">{d.votes} {d.votes === 1 ? "cliente apoiou" : "clientes apoiaram"} este pedido no roadmap; considere isso no alcance.</p>}
    </form>
  );
}

const initials = (name: string | null) => (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

function Comments({ d, can, busy, run }: Common) {
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isPublic, setPublic] = useState(false);
  const canAny = can("comment:internal") || can("comment:public");
  const [progress, setProgress] = useState<string | null>(null);

  return (
    <div className="stack">
      <ul className="thread">
        {d.comments.length === 0 && <li className="thread-empty"><Icon name="message" size={22} /><span>Ainda não há comentários.</span></li>}
        {d.comments.map((c) => {
          const client = c.author_kind === "CLIENT";
          return (
            <li key={c.id} className={`cm ${client ? "cm-client" : c.is_internal ? "cm-internal" : "cm-public"}`}>
              <span className="avatar sm" aria-hidden="true">{client ? "CL" : initials(c.author_name)}</span>
              <div className="cm-main">
                <p className="cm-head">
                  <strong>{client ? "Cliente" : (c.author_name ?? "—")}</strong>
                  {!client && c.author_role && <span className="muted small">{labelOf(STAFF_ROLES, c.author_role)}</span>}
                  <span className={`tag ${c.is_internal ? "warn-tag" : "outline"}`}>{c.is_internal ? "Interno" : "Público"}</span>
                  <time className="muted small push">{fmtDateTime(c.created_at)}</time>
                </p>
                <p className="pre cm-body">{c.body}</p>
                {c.attachments.length > 0 && <div className="thumbs">{c.attachments.map((a) => <FileChip key={a.id} a={a} />)}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {canAny && (
        <form className="composer stack" onSubmit={(e) => {
          e.preventDefault();
          if (!body.trim()) return;
          void run(() => api.addComment(d.id, body, !isPublic, files, (n, t) => setProgress(`Enviando anexo ${n} de ${t}…`)), () => { setBody(""); setFiles([]); setProgress(null); });
        }}>
          <textarea className="input" rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escreva um comentário…" aria-label="Comentário" />
          <AttachmentPicker files={files} onChange={setFiles} disabled={busy} inputId="cfiles" />
          <div className="row between">
            <label className="check"><input type="checkbox" checked={isPublic} disabled={!can("comment:public")} onChange={(e) => setPublic(e.target.checked)} /> Resposta pública (o cliente verá no acompanhamento)</label>
            <button className="btn btn-primary" disabled={busy || !body.trim()}><Icon name="message" size={16} /> {progress ?? "Enviar"}</button>
          </div>
          {isPublic && files.length > 0 && <p className="hint">Os anexos são visíveis só para a equipe; o cliente vê apenas o texto.</p>}
          {isPublic && d.whatsapp && !d.pii_masked && (
            <a className="btn" href={whatsappLink(d.whatsapp, `Olá! Sobre sua solicitação ${d.protocol}: acompanhe em ${window.location.origin}${window.location.pathname}`)} target="_blank" rel="noopener noreferrer">
              Avisar cliente no WhatsApp
            </a>
          )}
        </form>
      )}
    </div>
  );
}


/** Edição dos dados da solicitação. Só envia o que mudou; o banco valida de novo e a auditoria guarda antes/depois. */
function EditForm({ d, can, busy, run, onCancel }: Common & { onCancel: () => void }) {
  const pii = can("pii:view");
  const initial = {
    title: d.title, description: d.description, module: d.module, type: d.type,
    requester_name: d.requester_name, requester_role: d.requester_role,
    whatsapp: d.pii_masked ? "" : formatPhoneBR(d.whatsapp), requester_email: d.requester_email ?? "",
  };
  const [v, setV] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof initial, val: string) => setV((p) => ({ ...p, [k]: val }));

  function save(e: FormEvent) {
    e.preventDefault();
    const changed: Record<string, string> = {};
    for (const k of Object.keys(initial) as (keyof typeof initial)[]) {
      if (!pii && (k === "requester_name" || k === "whatsapp" || k === "requester_email")) continue;
      if (v[k].trim() !== initial[k].trim()) changed[k] = v[k].trim();
    }
    if (Object.keys(changed).length === 0) { setErr("Nenhuma alteração para salvar."); return; }
    if (changed.title !== undefined && (changed.title.length < 5 || changed.title.length > 140)) { setErr("O título precisa ter de 5 a 140 caracteres."); return; }
    if (changed.description !== undefined && (changed.description.length < 20 || changed.description.length > 8000)) { setErr("A descrição precisa ter de 20 a 8000 caracteres."); return; }
    setErr(null);
    void run(() => api.updateRequestFields(d.id, changed), onCancel);
  }

  return (
    <form className="stack" onSubmit={save}>
      <Banner kind="info">As alterações ficam registradas na auditoria, com o valor anterior e o novo.</Banner>
      {err && <Banner>{err}</Banner>}
      <Field label="Título" htmlFor="e-title"><input id="e-title" className="input" maxLength={140} value={v.title} onChange={(e) => set("title", e.target.value)} /></Field>
      <Field label="Descrição" htmlFor="e-desc"><textarea id="e-desc" className="input" rows={7} maxLength={8000} value={v.description} onChange={(e) => set("description", e.target.value)} /></Field>
      <div className="grid2">
        <Field label="Módulo" htmlFor="e-mod"><Select id="e-mod" value={v.module} onChange={(x) => set("module", x)} options={MODULES} /></Field>
        <Field label="Tipo de demanda" htmlFor="e-type"><Select id="e-type" value={v.type} onChange={(x) => set("type", x)} options={TYPES} /></Field>
      </div>
      {pii ? (
        <fieldset>
          <legend>Solicitante</legend>
          <div className="grid2">
            <Field label="Nome" htmlFor="e-name"><input id="e-name" className="input" maxLength={120} value={v.requester_name} onChange={(e) => set("requester_name", e.target.value)} /></Field>
            <Field label="Cargo / função" htmlFor="e-role"><Select id="e-role" value={v.requester_role} onChange={(x) => set("requester_role", x)} options={REQUESTER_ROLES} /></Field>
            <Field label="WhatsApp" htmlFor="e-wa"><input id="e-wa" className="input" inputMode="tel" value={v.whatsapp} onChange={(e) => set("whatsapp", maskPhoneInput(e.target.value))} /></Field>
            <Field label="E-mail" htmlFor="e-mail" hint="Deixe vazio para remover."><input id="e-mail" className="input" type="email" maxLength={160} value={v.requester_email} onChange={(e) => set("requester_email", e.target.value)} /></Field>
          </div>
        </fieldset>
      ) : (
        <p className="hint">Seu perfil não pode editar os dados pessoais do solicitante.</p>
      )}
      <div className="row">
        <button className="btn btn-primary" disabled={busy}><Icon name="save" size={16} /> Salvar alterações</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
