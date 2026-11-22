import { useState } from "react";
import type { AuditEntry } from "../../lib/types";
import { fmtDateTime } from "../../lib/format";

export function diff(prev: unknown, next: unknown): { key: string; from: unknown; to: unknown }[] {
  const a = (prev ?? {}) as Record<string, unknown>;
  const b = (next ?? {}) as Record<string, unknown>;
  const out: { key: string; from: unknown; to: unknown }[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "updated_at") continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ key: k, from: a[k], to: b[k] });
  }
  return out;
}

const show = (v: unknown) =>
  v === undefined || v === null ? "—" : typeof v === "string" ? (v.length > 90 ? v.slice(0, 90) + "…" : v) : JSON.stringify(v);

export function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (entries.length === 0) return <p className="muted">Sem eventos.</p>;
  return (
    <ol className="audit">
      {entries.map((e) => {
        const changes = e.action === "UPDATE" || e.action === "DELETE" ? diff(e.previous, e.next) : [];
        const expanded = open === e.id;
        return (
          <li key={e.id}>
            <button type="button" className="audit-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : e.id)}>
              <span className={`tag a-${e.action}`}>{e.action}</span>
              <span className="tag outline">{e.entity}</span>
              <strong>{e.user}</strong>
              <span className="muted small push">{fmtDateTime(e.created_at)}</span>
            </button>
            {expanded && (
              <div className="audit-body">
                <p className="muted small">IP: {e.ip ?? "—"} · {e.user_agent ?? "—"}</p>
                {changes.length > 0 ? (
                  <table className="diff">
                    <thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead>
                    <tbody>
                      {changes.map((c) => (
                        <tr key={c.key}>
                          <td className="mono">{c.key}</td>
                          <td className="old">{show(c.from)}</td>
                          <td className="new">{show(c.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <pre className="json">{JSON.stringify(e.next ?? e.previous ?? {}, null, 2)}</pre>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
