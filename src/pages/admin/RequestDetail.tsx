import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as api from "../../lib/api";
import type { Ctx, Detail } from "../../lib/types";
import { MODULES, PRIORITIES, REQUESTER_ROLES, STATUSES, TYPES, labelOf } from "../../lib/labels";
import { errMsg, fmtBytes, fmtDateTime } from "../../lib/format";
import { formatPhoneBR, maskPhoneInput, whatsappLink } from "../../lib/phone";
import { Banner, Field, Modal, Select, Spinner } from "../../components/ui";
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

function Details({ d, can, busy, run, clinics, onClose }: Common & { clinics: { id: string; name: string }[]; onClose: () => void }) {
  const [mergeProto, setMergeProto] = useState("");
  const [linkId, setLinkId] = useState("");
  const [ext, setExt] = useState({ system: d.external_system ?? "", id: d.external_id ?? "" });
  const [tags, setTags] = useState(d.tags.join(", "));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setExt({ system: d.external_system ?? "", id: d.external_id ?? "" }); }, [d.external_system, d.external_id]);

  async function openAttachment(path: string) {
    try {
      window.open(await api.signedAttachmentUrl(path), "_blank", "noopener,noreferrer");
    } catch (e) {
      alert(errMsg(e));
    }
  }

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
    <div className="stack">
      {can("request:edit") && (
        <div className="row"><button className="btn btn-sm" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Editar dados da solicitação</button></div>
      )}
      <dl className="kv">
        <div><dt>Clínica / unidade</dt><dd>{d.clinic_name ?? <span className="warn">{d.pending_clinic_name} (novo vínculo)</span>}{d.unit_name ? ` — ${d.unit_name}` : ""}</dd></div>
        <div>
          <dt>Solicitante</dt>
          <dd>{d.requester_name} · {labelOf(REQUESTER_ROLES, d.requester_role)} {d.pii_masked && <span className="tag outline">mascarado (LGPD)</span>}</dd>
        </div>
        <div>
          <dt>WhatsApp</dt>
          <dd>
            {d.pii_masked ? d.whatsapp : (
              <a href={whatsappLink(d.whatsapp, `Olá! Sobre sua solicitação ${d.protocol} no Conceive…`)} target="_blank" rel="noopener noreferrer">{formatPhoneBR(d.whatsapp)}</a>
            )}
          </dd>
        </div>
        {d.requester_email && <div><dt>E-mail</dt><dd>{d.pii_masked ? d.requester_email : <a href={`mailto:${d.requester_email}`}>{d.requester_email}</a>}</dd></div>}
        <div><dt>Módulo · Tipo</dt><dd>{labelOf(MODULES, d.module)} · {labelOf(TYPES, d.type)}</dd></div>
        <div><dt>Enviada em</dt><dd>{fmtDateTime(d.created_at)}</dd></div>
        <div><dt>Apoios no roadmap</dt><dd>{d.votes}{d.origin === "IMPORT" ? " · importada da planilha" : ""}</dd></div>
        {d.csat?.score != null && <div><dt>Satisfação do cliente</dt><dd>{"★".repeat(d.csat.score)}{"☆".repeat(5 - d.csat.score)} ({d.csat.score}/5){d.csat.comment ? <> — <span className="pre">{d.csat.comment}</span></> : null}</dd></div>}
        <div><dt>Prioridade · RICE</dt><dd>{labelOf(PRIORITIES, d.priority)} · {d.rice.score ?? "—"}</dd></div>
      </dl>

      <div className="field">
        <label className="label" htmlFor="st">Status</label>
        <Select id="st" value={d.status} disabled={!can("request:update_status") || busy} onChange={(s) => void run(() => api.setStatus(d.id, s))} options={STATUSES} />
        {!can("request:update_status") && <p className="hint">Seu perfil não pode alterar o status.</p>}
      </div>

      <div>
        <h3>Descrição</h3>
        {/* texto puro: React escapa o conteúdo, não há HTML do usuário */}
        <p className="pre box">{d.description}</p>
      </div>

      {d.attachments.length > 0 && (
        <div>
          <h3>Anexos</h3>
          <ul className="files">
            {d.attachments.map((a) => (
              <li key={a.id}>
                <span>{a.file_name} <small className="muted">({fmtBytes(a.size_bytes)})</small></span>
                <button className="link" onClick={() => void openAttachment(a.storage_path)}>abrir</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.merged_into && <Banner kind="info">Esta solicitação foi mesclada em <strong className="mono">{d.merged_into.protocol}</strong>.
        {can("request:merge") && <> <button className="link" disabled={busy} onClick={() => void run(() => api.unmergeRequest(d.id))}>desfazer</button></>}</Banner>}

      {d.duplicates.length > 0 && (
        <div>
          <h3>Pedidos semelhantes ({d.duplicates.length} {d.duplicates.length === 1 ? "clínica" : "clínicas"} + esta)</h3>
          <ul className="files">
            {d.duplicates.map((x) => (
              <li key={x.id}>
                <span><span className="mono">{x.protocol}</span> — {x.title} <small className="muted">({x.clinic_name ?? "sem clínica"})</small></span>
                {can("request:merge") && <button className="link danger" disabled={busy} onClick={() => void run(() => api.unmergeRequest(x.id))}>desfazer</button>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {can("request:merge") && !d.merged_into && (
        <form className="row" onSubmit={(e) => void doMerge(e)}>
          <input className="input" placeholder="Digite o protocolo da solicitação principal" value={mergeProto} onChange={(e) => setMergeProto(e.target.value)} aria-label="Protocolo para mesclar" />
          <button className="btn" disabled={busy || !mergeProto.trim()}><Icon name="merge" size={15} /> Mesclar nesta</button>
        </form>
      )}

      {!d.clinic_id && can("request:link_clinic") && (
        <div className="row">
          <Select value={linkId} onChange={setLinkId} options={clinics.map((c) => [c.id, c.name] as const)} placeholder="Vincular a uma clínica cadastrada…" ariaLabel="Clínica" />
          <button className="btn" disabled={busy || !linkId} onClick={() => void run(() => api.linkClinic(d.id, linkId, null))}><Icon name="link" size={15} /> Vincular</button>
        </div>
      )}

      {can("request:publish") && (
        <div className="field">
          <label className="check"><input type="checkbox" checked={d.is_public} disabled={busy} onChange={(e) => {
            const on = e.target.checked;
            if (on && !confirm("Publicar no roadmap? O título e a descrição ficarão visíveis a qualquer pessoa, sem nome nem contato do solicitante. Confira se não há dados de pacientes.")) return;
            void run(() => api.setRequestPublic(d.id, on));
          }} /> Mostrar no roadmap público (permite votos)</label>
        </div>
      )}

      {can("request:export_dev") && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setExternalRef(d.id, ext.system, ext.id)); }}>
          <Select value={ext.system} onChange={(s) => setExt({ ...ext, system: s })} options={[["REDMINE", "Redmine"], ["PIPEFY", "Pipefy"]]} placeholder="Sistema externo" ariaLabel="Sistema externo" />
          <input className="input" placeholder="Digite o ID da tarefa" value={ext.id} maxLength={80} onChange={(e) => setExt({ ...ext, id: e.target.value })} aria-label="ID externo" />
          <button className="btn" disabled={busy}><Icon name="save" size={15} /> Salvar vínculo</button>
        </form>
      )}
      {can("request:export_dev") && !d.external_id && (
        <div className="row">
          {(["REDMINE", "PIPEFY"] as const).map((sys) => (
            <button key={sys} className="btn" disabled={busy} onClick={() => void run(async () => {
              const r = await api.createExternalTask(d.id, sys);
              if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
            })}>Criar tarefa no {sys === "REDMINE" ? "Redmine" : "Pipefy"}</button>
          ))}
        </div>
      )}

      {can("request:prioritize") && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => api.setTags(d.id, tags.split(",").map((t) => t.trim()).filter(Boolean))); }}>
          <input className="input" placeholder="Digite as tags, separadas por vírgula" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Tags" />
          <button className="btn" disabled={busy}><Icon name="tag" size={15} /> Salvar tags</button>
        </form>
      )}
      {!can("request:prioritize") && d.tags.length > 0 && <p>{d.tags.map((t) => <span key={t} className="tag outline">{t}</span>)}</p>}

      {can("request:archive") && (
        <button className="btn btn-danger" disabled={busy} onClick={() => { if (confirm("Arquivar esta solicitação? Ela não é excluída, apenas ocultada.")) void run(() => api.archiveRequest(d.id), onClose); }}>
          <Icon name="archive" size={15} /> Arquivar
        </button>
      )}
    </div>
  );
}

function Prioritization({ d, can, busy, run }: Common) {
  const [f, setF] = useState({
    priority: d.priority,
    reach: String(d.rice.reach ?? ""),
    impact: String(d.rice.impact ?? ""),
    confidence: String(d.rice.confidence ?? ""),
    effort: String(d.rice.effort ?? ""),
  });
  const allowed = can("request:prioritize");
  const live = (() => {
    const r = Number(f.reach), i = Number(f.impact), c = Number(f.confidence), e = Number(f.effort);
    return e > 0 && f.reach !== "" ? Math.round(((r * i * c) / e) * 100) / 100 : null;
  })();

  return (
    <form className="grid2" onSubmit={(e) => { e.preventDefault(); void run(() => api.setPriority(d.id, f.priority, Number(f.reach), Number(f.impact), Number(f.confidence), Number(f.effort))); }}>
      <div className="field"><label className="label" htmlFor="pr">Prioridade</label>
        <Select id="pr" value={f.priority} disabled={!allowed} onChange={(v) => setF({ ...f, priority: v })} options={PRIORITIES} /></div>
      <div className="field"><label className="label" htmlFor="re">Alcance (clínicas/usuários)</label>
        <input id="re" className="input" type="number" min={0} step={1} required disabled={!allowed} value={f.reach} onChange={(e) => setF({ ...f, reach: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="im">Impacto</label>
        <select id="im" className="input" required disabled={!allowed} value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })}>
          <option value="">Selecione</option><option value="0.25">0,25 — mínimo</option><option value="0.5">0,5 — baixo</option><option value="1">1 — médio</option><option value="2">2 — alto</option><option value="3">3 — massivo</option>
        </select></div>
      <div className="field"><label className="label" htmlFor="co">Confiança (0 a 1)</label>
        <input id="co" className="input" type="number" min={0} max={1} step={0.1} required disabled={!allowed} value={f.confidence} onChange={(e) => setF({ ...f, confidence: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="ef">Esforço (pessoa-mês)</label>
        <input id="ef" className="input" type="number" min={0.1} step={0.1} required disabled={!allowed} value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value })} /></div>
      <div className="field"><span className="label">Score RICE</span><p className="big">{live ?? d.rice.score ?? "—"}</p></div>
      {allowed ? <button className="btn btn-primary full" disabled={busy}>Salvar priorização</button> : <p className="hint full">Seu perfil só pode visualizar.</p>}
      <p className="hint full">{d.votes > 0 ? `${d.votes} ${d.votes === 1 ? "cliente apoiou" : "clientes apoiaram"} esta solicitação no roadmap (considere no Alcance). ` : ""}RICE = (Alcance × Impacto × Confiança) ÷ Esforço. O cálculo oficial é feito no banco ao salvar.</p>
    </form>
  );
}

function Comments({ d, can, busy, run }: Common) {
  const [body, setBody] = useState("");
  const [isPublic, setPublic] = useState(false);
  const canAny = can("comment:internal") || can("comment:public");
  return (
    <div className="stack">
      <ul className="thread">
        {d.comments.length === 0 && <li className="muted">Sem comentários.</li>}
        {d.comments.map((c) => (
          <li key={c.id} className={c.is_internal ? "internal" : "public"}>
            <p className="small muted"><span className="tag">{c.is_internal ? "Interno" : "Público"}</span> {c.author_kind === "CLIENT" ? <span className="tag from-client">Cliente</span> : null} {c.author_kind === "CLIENT" ? "" : (c.author_name ?? "—")} · {fmtDateTime(c.created_at)}</p>
            <p className="pre">{c.body}</p>
          </li>
        ))}
      </ul>
      {canAny && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (body.trim()) void run(() => api.addComment(d.id, body, !isPublic), () => setBody("")); }}>
          <textarea className="input" rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escreva um comentário…" aria-label="Comentário" />
          <div className="row between">
            <label className="check"><input type="checkbox" checked={isPublic} disabled={!can("comment:public")} onChange={(e) => setPublic(e.target.checked)} /> Resposta pública (o cliente verá no acompanhamento)</label>
            <button className="btn btn-primary" disabled={busy || !body.trim()}>Enviar</button>
          </div>
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
