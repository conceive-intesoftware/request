/** Ordem das colunas da exportação (o jsonb do Postgres NÃO preserva a ordem das chaves). */
export const EXPORT_COLUMNS = [
  "protocolo", "titulo", "clinica", "modulo", "tipo", "status", "prioridade",
  "rice", "sistema_externo", "id_externo", "criado_em",
];

/** Títulos legíveis (com acento) do cabeçalho do CSV. */
const HEADER_LABELS: Record<string, string> = {
  protocolo: "Protocolo", titulo: "Título", clinica: "Clínica", modulo: "Módulo", tipo: "Tipo", status: "Status",
  prioridade: "Prioridade", rice: "RICE", sistema_externo: "Sistema externo", id_externo: "ID externo", criado_em: "Criado em",
};

/** CSV seguro para Excel: protege contra "CSV/formula injection" (=, +, -, @) e escapa aspas. */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const headers = columns ?? Object.keys(rows[0]);
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [headers.map((h) => `"${HEADER_LABELS[h] ?? h}"`).join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\r\n");
}

/** Só no navegador. BOM para o Excel abrir acentos corretamente. */
export function downloadCsv(fileName: string, csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
