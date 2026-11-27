import { useState } from "react";
import type { ListRow } from "../../lib/types";
import { fmtDate } from "../../lib/format";
import { MODULES, PRIORITIES, STATUSES, labelOf } from "../../lib/labels";

/** Quadro Kanban: arrastar um cartão para outra coluna altera o status (somente quem tem permissão). */
export function Kanban({
  rows,
  canMove,
  onOpen,
  onMove,
}: {
  rows: ListRow[];
  canMove: boolean;
  onOpen: (id: string) => void;
  onMove: (id: string, status: string) => Promise<void>;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  return (
    <div className="kanban">
      {STATUSES.filter(([k]) => k !== "ARQUIVADO").map(([status, label]) => {
        const cards = rows.filter((r) => r.status === status);
        return (
          <section
            key={status}
            className={`col st-${status} ${over === status ? "over" : ""}`}
            onDragOver={(e) => { if (canMove) { e.preventDefault(); setOver(status); } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = dragId ?? e.dataTransfer.getData("text/plain");
              setDragId(null);
              const card = rows.find((r) => r.id === id);
              if (canMove && card && card.status !== status) void onMove(id, status);
            }}
            aria-label={label}
          >
            <header><span className="col-dot" aria-hidden="true" /><strong>{label}</strong><span className="col-count" aria-label={`${cards.length} solicitações`}>{cards.length}</span></header>
            <div className="col-body">
            {cards.map((r) => (
              <article
                key={r.id}
                className={`card-k p-${r.priority}`}
                draggable={canMove}
                onDragStart={(e) => { setDragId(r.id); e.dataTransfer.setData("text/plain", r.id); }}
                onClick={() => onOpen(r.id)}
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onOpen(r.id)}
              >
                <p className="k-top"><span className="k-proto">{r.protocol}</span><span className="k-date">{fmtDate(r.created_at)}</span></p>
                <p className="k-title" title={r.title}>{r.title}</p>
                <p className="k-clinic">{r.clinic_name ?? `${r.pending_clinic_name ?? "—"} (novo)`}</p>
                <p className="k-tags">
                  <span className="tag outline">{labelOf(MODULES, r.module)}</span>
                  <span className={`tag prio-${r.priority}`}>{labelOf(PRIORITIES, r.priority)}</span>
                  {r.duplicates_count > 0 && <span className="tag">+{r.duplicates_count}</span>}
                  {r.rice_score !== null && <span className="tag outline">RICE {r.rice_score}</span>}
                  {r.awaiting_reply && <span className="tag warn-tag">Aguardando resposta</span>}
                </p>
              </article>
            ))}
            {cards.length === 0 && <p className="col-empty">{canMove ? "Arraste um cartão para cá" : "Nenhuma solicitação"}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
