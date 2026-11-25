import { useMemo, useState } from "react";
import type { AuditEntry } from "../../lib/types";
import { MODULES, PRIORITIES, REQUESTER_ROLES, STAFF_ROLES, STATUSES, TYPES, labelOf } from "../../lib/labels";
import { fmtDateTime } from "../../lib/format";
import { Icon, type IconName } from "../../components/Icon";

export function diff(prev: unknown, next: unknown): { key: string; from: unknown; to: unknown }[] {
  const a = (prev ?? {}) as Record<string, unknown>;
  const b = (next ?? {}) as Record<string, unknown>;
  const out: { key: string; from: unknown; to: unknown }[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (HIDDEN.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ key: k, from: a[k], to: b[k] });
  }
  return out;
}

/** Campos técnicos que não ajudam a entender o que mudou. */
const HIDDEN = new Set(["updated_at", "id", "tracking_token", "protocol", "created_at", "submitted_by", "deleted_by", "request_id", "author_id", "search_text"]);

const FIELD: Record<string, string> = {
  title: "Título", description: "Descrição", status: "Status", priority: "Prioridade", module: "Módulo", type: "Tipo de demanda",
  requester_name: "Nome do solicitante", requester_role: "Cargo do solicitante", whatsapp_e164: "WhatsApp", requester_email: "E-mail",
  clinic_id: "Clínica vinculada", unit_id: "Unidade", pending_clinic_name: "Clínica informada (a vincular)",
  rice_reach: "Alcance", rice_impact: "Impacto", rice_confidence: "Confiança", rice_effort: "Esforço", rice_score: "Pontuação",
  is_public: "Roadmap público", external_system: "Sistema externo", external_id: "ID externo", merged_into_id: "Mesclada em",
  deleted_at: "Arquivada em", completed_at: "Concluída em", csat_score: "Nota do cliente", csat_comment: "Comentário do cliente", csat_at: "Avaliada em",
  body: "Texto", is_internal: "Comentário interno", author_kind: "Autor", origin: "Origem", name: "Nome", role: "Papel", active: "Ativo",
  mfa_exempt: "Autenticador dispensado",
};
const fieldLabel = (k: string) => FIELD[k] ?? k.replace(/_/g, " ");

const ENUMS: Record<string, readonly (readonly [string, string])[]> = {
  status: STATUSES, priority: PRIORITIES, module: MODULES, type: TYPES, requester_role: REQUESTER_ROLES, role: STAFF_ROLES,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T/;

export function fmtValue(key: string, v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "string") {
    if (ENUMS[key]) return labelOf(ENUMS[key], v);
    if (key === "author_kind") return v === "CLIENT" ? "Cliente" : "Equipe";
    if (UUID.test(v)) return "(registro vinculado)";
    if (ISO.test(v)) return fmtDateTime(v);
    return v.length > 140 ? v.slice(0, 140) + "…" : v;
  }
  return String(v);
}

type Tone = "create" | "update" | "view" | "other" | "danger";
interface Item {
  key: string; ids: number[]; icon: IconName; tone: Tone; title: string; detail?: string;
  who: string; role: string | null; at: string; count: number; entries: AuditEntry[];
}

function who(user: string): { name: string; role: string | null } {
  const m = /^(.*) \((\w+)\)$/.exec(user);
  return m ? { name: m[1], role: labelOf(STAFF_ROLES, m[2]) } : { name: user, role: null };
}

function describe(e: AuditEntry): { icon: IconName; tone: Tone; title: string; detail?: string } {
  const changes = e.action === "UPDATE" ? diff(e.previous, e.next) : [];
  if (e.entity === "request_comments") {
    const n = (e.next ?? e.previous ?? {}) as Record<string, unknown>;
    const client = n.author_kind === "CLIENT";
    if (e.action === "CREATE") return { icon: "message", tone: "create", title: client ? "Cliente respondeu na página de acompanhamento" : n.is_internal === false ? "Resposta pública enviada ao cliente" : "Comentário interno registrado" };
    return { icon: "message", tone: "update", title: "Comentário alterado" };
  }
  switch (e.action) {
    case "CREATE": return { icon: "file-plus", tone: "create", title: "Solicitação registrada" };
    case "VIEW_SENSITIVE": return { icon: "eye", tone: "view", title: "Consultou os dados pessoais do solicitante", detail: "Registro obrigatório (LGPD)" };
    case "EXPORT": return { icon: "download", tone: "other", title: "Exportou dados" };
    case "LOGIN": return { icon: "lock", tone: "other", title: "Entrou no painel" };
    case "DELETE": return { icon: "trash", tone: "danger", title: "Registro removido" };
  }
  if (changes.length === 0) return { icon: "refresh", tone: "update", title: "Atualização interna", detail: "Sem alteração em campos visíveis" };
  const archived = changes.find((c) => c.key === "deleted_at" && c.to);
  if (archived) return { icon: "archive", tone: "danger", title: "Solicitação arquivada" };
  const st = changes.find((c) => c.key === "status");
  if (st) return { icon: "columns", tone: "update", title: "Status alterado", detail: `${fmtValue("status", st.from)} → ${fmtValue("status", st.to)}` };
  const first = changes.slice(0, 2).map((c) => fieldLabel(c.key)).join(", ");
  return { icon: "edit", tone: "update", title: changes.length === 1 ? `${fieldLabel(changes[0].key)} alterado` : "Dados alterados", detail: changes.length > 2 ? `${first} e mais ${changes.length - 2}` : first };
}

/** Junta consultas seguidas da mesma pessoa a dados pessoais (era uma linha por clique). */
function build(entries: AuditEntry[]): Item[] {
  const items: Item[] = [];
  for (const e of entries) {
    const d = describe(e), w = who(e.user);
    const prev = items[items.length - 1];
    if (prev && e.action === "VIEW_SENSITIVE" && prev.entries[0].action === "VIEW_SENSITIVE" && prev.who === w.name) {
      prev.count++; prev.entries.push(e); prev.ids.push(e.id);
      continue;
    }
    items.push({ key: String(e.id), ids: [e.id], ...d, who: w.name, role: w.role, at: e.created_at, count: 1, entries: [e] });
  }
  return items;
}

const dayKey = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" });
function dayLabel(iso: string): string {
  const today = dayKey(new Date().toISOString());
  const yest = dayKey(new Date(Date.now() - 86400000).toISOString());
  const k = dayKey(iso);
  if (k === today) return "Hoje";
  if (k === yest) return "Ontem";
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza", day: "numeric", month: "long", year: "numeric" });
}
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" });

export function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = useMemo(() => build(entries), [entries]);
  const days = useMemo(() => {
    const g: { label: string; items: Item[] }[] = [];
    for (const it of items) {
      const label = dayLabel(it.at);
      const last = g[g.length - 1];
      if (last && last.label === label) last.items.push(it); else g.push({ label, items: [it] });
    }
    return g;
  }, [items]);

  if (entries.length === 0) return <p className="muted">Sem eventos registrados.</p>;
  return (
    <div className="audit2">
      <p className="muted small audit-sum">{entries.length} {entries.length === 1 ? "evento" : "eventos"} registrados, do mais recente para o mais antigo. A trilha não pode ser alterada nem apagada.</p>
      {days.map((day) => (
        <section key={day.label} className="audit-day" aria-label={day.label}>
          <h3 className="audit-day-h">{day.label}</h3>
          <ol className="timeline">
            {day.items.map((it) => {
              const e = it.entries[0];
              const changes = e.action === "UPDATE" ? diff(e.previous, e.next) : [];
              const expanded = open === it.key;
              return (
                <li key={it.key} className={`tl tl-${it.tone}`}>
                  <span className="tl-dot" aria-hidden="true"><Icon name={it.icon} size={14} /></span>
                  <button type="button" className="tl-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : it.key)}>
                    <span className="tl-main">
                      <strong>{it.title}{it.count > 1 ? <span className="tl-count"> × {it.count}</span> : null}</strong>
                      {it.detail && <span className="tl-detail">{it.detail}</span>}
                      <span className="tl-who">{it.who}{it.role ? ` · ${it.role}` : ""}</span>
                    </span>
                    <span className="tl-time">{hhmm(it.at)}</span>
                    <Icon name={expanded ? "chevron-down" : "chevron-right"} size={16} className="tl-chev" />
                  </button>
                  {expanded && (
                    <div className="tl-body">
                      {changes.length > 0 && (
                        <table className="diff">
                          <thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead>
                          <tbody>
                            {changes.map((c) => (
                              <tr key={c.key}><td>{fieldLabel(c.key)}</td><td className="old">{fmtValue(c.key, c.from)}</td><td className="new">{fmtValue(c.key, c.to)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {changes.length === 0 && e.action === "CREATE" && e.next && (
                        <dl className="tl-kv">
                          {Object.entries(e.next).filter(([k]) => !HIDDEN.has(k) && e.next![k] !== null && e.next![k] !== "").slice(0, 8).map(([k, v]) => (
                            <div key={k}><dt>{fieldLabel(k)}</dt><dd>{fmtValue(k, v)}</dd></div>
                          ))}
                        </dl>
                      )}
                      {it.count > 1 && <p className="small muted">Horários: {it.entries.map((x) => hhmm(x.created_at)).reverse().join(", ")}</p>}
                      <p className="small muted tl-tech">Registro completo em {fmtDateTime(e.created_at)} · IP {e.ip ?? "—"} · {e.user_agent ? e.user_agent.slice(0, 90) : "—"}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
