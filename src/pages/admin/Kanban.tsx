import { useState } from "react";
import type { ListRow } from "../../lib/types";
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
            className={`col ${over === status ? "over" : ""}`}
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
            <header><strong>{label}</strong> <span className="tag">{cards.length}</span></header>
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
                <p className="mono small muted">{r.protocol}</p>
                <p className="k-title">{r.title}</p>
                <p className="small muted">{r.clinic_name ?? `${r.pending_clinic_name ?? "—"} (novo)`}</p>
                <p className="small">
                  <span className="tag outline">{labelOf(MODULES, r.module)}</span>{" "}
                  <span className={`tag prio-${r.priority}`}>{labelOf(PRIORITIES, r.priority)}</span>
                  {r.duplicates_count > 0 && <span className="tag">+{r.duplicates_count}</span>}
                  {r.rice_score !== null && <span className="tag outline">RICE {r.rice_score}</span>}
                </p>
              </article>
            ))}
            {cards.length === 0 && <p className="muted small empty">vazio</p>}
          </section>
        );
      })}
    </div>
  );
}
