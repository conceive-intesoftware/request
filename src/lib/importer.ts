// Importação da planilha antiga (CSV exportado do Google Sheets/Excel). Tudo roda no navegador;
// o servidor valida de novo cada linha (admin_import_requests).
import type { ImportRow } from "./types";

/** Lê CSV (RFC 4180): aspas, vírgulas e quebras de linha dentro de campos. Detecta ',' ou ';'. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();

export const FIELDS = ["created_at", "clinic", "unit", "name", "role", "whatsapp", "module", "type", "title", "description", "status", "email"] as const;
export type Field = (typeof FIELDS)[number];
export const FIELD_LABEL: Record<Field, string> = {
  created_at: "Data/hora", clinic: "Clínica", unit: "Unidade", name: "Nome do solicitante", role: "Cargo", whatsapp: "WhatsApp",
  module: "Módulo", type: "Tipo de demanda", title: "Título", description: "Descrição", status: "Status", email: "E-mail",
};
export const REQUIRED: Field[] = ["clinic", "name", "title", "description"];

const ALIASES: Record<Field, string[]> = {
  created_at: ["carimbo de data/hora", "carimbo de data hora", "data e hora", "data/hora", "timestamp", "data de envio", "criado em", "data"],
  clinic: ["clinica", "nome da clinica", "clinica/unidade", "unidade/clinica", "empresa", "cliente"],
  unit: ["unidade"],
  name: ["nome", "seu nome", "nome do solicitante", "solicitante", "nome completo"],
  role: ["cargo", "funcao", "cargo/funcao", "seu cargo", "seu cargo/funcao"],
  whatsapp: ["whatsapp", "telefone", "celular", "contato", "whatsapp para retorno", "telefone/whatsapp"],
  module: ["modulo", "modulo do sistema", "area", "setor"],
  type: ["tipo", "tipo de demanda", "tipo de solicitacao", "categoria"],
  title: ["titulo", "titulo da solicitacao", "assunto", "resumo"],
  description: ["descricao", "descricao detalhada", "descricao da solicitacao", "detalhes", "solicitacao", "pedido", "o que voce precisa"],
  status: ["status", "situacao"],
  email: ["email", "e mail", "e-mail"],
};

/** Sugere qual coluna da planilha corresponde a cada campo (índice, ou -1). Cada coluna é usada uma vez. */
export function detectColumns(headers: string[]): Record<Field, number> {
  const h = headers.map(norm);
  const out = Object.fromEntries(FIELDS.map((f) => [f, -1])) as Record<Field, number>;
  const used = new Set<number>();
  const take = (f: Field, i: number) => { out[f] = i; used.add(i); };
  for (const f of FIELDS) { // 1ª passada: igualdade exata (na ordem de prioridade dos apelidos)
    for (const a of ALIASES[f]) {
      const i = h.findIndex((x, idx) => x === norm(a) && !used.has(idx));
      if (i >= 0) { take(f, i); break; }
    }
  }
  for (const f of FIELDS) { // 2ª: o cabeçalho contém o apelido (ex.: "Descreva sua solicitação")
    if (out[f] >= 0) continue;
    for (const a of ALIASES[f]) {
      if (a.length < 5) continue;
      const i = h.findIndex((x, idx) => !used.has(idx) && x.includes(norm(a)));
      if (i >= 0) { take(f, i); break; }
    }
  }
  return out;
}

const has = (t: string, ...w: string[]) => w.some((x) => t.includes(x));
export function mapRole(v: string): string {
  const t = norm(v);
  if (has(t, "dono", "socio", "proprietar", "diretor")) return "DONO_SOCIO";
  if (has(t, "administr", "gerente", "gestor", "financeiro")) return "ADMINISTRADOR";
  if (has(t, "recepc", "atendente", "secretar")) return "RECEPCIONISTA";
  if (has(t, "medic", "doutor", "dr ")) return "MEDICO";
  if (has(t, "enferm", "tecnico de enf")) return "ENFERMEIRO";
  if (has(t, "farmac")) return "FARMACEUTICO";
  if (has(t, "contad")) return "CONTADOR";
  return "OUTRO";
}
export function mapModule(v: string): string {
  const t = norm(v);
  if (has(t, "financ")) return "FINANCEIRO";
  if (has(t, "agenda", "agendamento")) return "AGENDA";
  if (has(t, "prontu")) return "PRONTUARIO";
  if (has(t, "estoque", "farmac")) return "ESTOQUE_FARMACIA";
  if (has(t, "tiss", "fatur")) return "FATURAMENTO_TISS";
  return "OUTRO";
}
export function mapType(v: string): string {
  const t = norm(v);
  if (has(t, "melhor", "fluxo")) return "MELHORIA_FLUXO";
  if (has(t, "sugest", "tecnic")) return "SUGESTAO_TECNICA";
  return "NOVA_FUNCIONALIDADE";
}
export function mapStatus(v: string): string {
  const t = norm(v);
  if (has(t, "conclu", "entreg", "finaliz", "resolv", "pronto", "feito")) return "CONCLUIDO";
  if (has(t, "desenvolv", "andamento", "executando")) return "EM_DESENVOLVIMENTO";
  if (has(t, "roadmap", "aprovad")) return "APROVADO_ROADMAP";
  if (has(t, "analise")) return "EM_ANALISE_PRODUTO";
  return "RECEBIDO";
}

/** "22/11/2026 14:30:05", "22/11/26", "2026-11-22 14:30" ou ISO → ISO com fuso de Fortaleza (-03:00). */
export function parseDate(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  const pad = (n: string) => n.padStart(2, "0");
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  let y: string, mo: string, d: string, hh = "00", mm = "00", ss = "00";
  if (m) {
    [, d, mo, y] = m as unknown as string[];
    if (y.length === 2) y = `20${y}`;
    hh = m[4] ?? "00"; mm = m[5] ?? "00"; ss = m[6] ?? "00";
  } else {
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?/);
    if (!m) return null;
    [, y, mo, d] = m as unknown as string[];
    hh = m[4] ?? "00"; mm = m[5] ?? "00"; ss = m[6] ?? "00";
    if (m[7]) {
      const iso = `${y}-${mo}-${d}T${pad(hh)}:${mm}:${ss}${m[7] === "Z" ? "Z" : m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]}`;
      return Number.isNaN(Date.parse(iso)) ? null : iso;
    }
  }
  const mon = Number(mo), day = Number(d);
  if (mon < 1 || mon > 12 || day < 1 || day > new Date(Date.UTC(Number(y), mon, 0)).getUTCDate() || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return null;
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${mm}:${ss}-03:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Chave de deduplicação: importar o mesmo arquivo de novo não duplica pedidos. */
export const rowKey = async (iso: string | null, name: string, title: string, clinic: string) =>
  (await sha256Hex(`${iso ?? ""}|${norm(name)}|${norm(title)}|${norm(clinic)}`)).slice(0, 40);

export interface BuildResult {
  rows: ImportRow[];
  issues: { line: number; reason: string }[];   // line = número da linha na planilha (cabeçalho = 1)
  duplicatesInFile: number;
}

/** Converte a tabela em linhas prontas para o banco, apontando as que não passam nas regras. */
export async function buildRows(table: string[][], map: Record<Field, number>): Promise<BuildResult> {
  const out: BuildResult = { rows: [], issues: [], duplicatesInFile: 0 };
  const seen = new Set<string>();
  const cell = (r: string[], f: Field) => (map[f] >= 0 ? (r[map[f]] ?? "").trim() : "");
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const line = i + 1;
    const name = cell(r, "name"), title = cell(r, "title"), desc = cell(r, "description"), clinic = cell(r, "clinic");
    const rawDate = cell(r, "created_at");
    const iso = rawDate ? parseDate(rawDate) : null;
    const problems: string[] = [];
    if (name.length < 3 || name.length > 120) problems.push("nome do solicitante ausente ou inválido");
    if (clinic.length < 3) problems.push("clínica ausente");
    if (title.length < 5 || title.length > 140) problems.push("título precisa ter de 5 a 140 caracteres");
    if (desc.length < 20) problems.push("descrição com menos de 20 caracteres");
    if (rawDate && !iso) problems.push(`data “${rawDate}” não reconhecida (use dd/mm/aaaa hh:mm)`);
    if (problems.length) { out.issues.push({ line, reason: problems.join("; ") }); continue; }
    const key = await rowKey(iso, name, title, clinic);
    if (seen.has(key)) { out.duplicatesInFile++; continue; }
    seen.add(key);
    out.rows.push({
      key, created_at: iso, clinic, unit: cell(r, "unit"), name,
      role: map.role >= 0 ? mapRole(cell(r, "role")) : "OUTRO",
      whatsapp: cell(r, "whatsapp"),
      module: map.module >= 0 ? mapModule(cell(r, "module")) : "OUTRO",
      type: map.type >= 0 ? mapType(cell(r, "type")) : "NOVA_FUNCIONALIDADE",
      title, description: desc.slice(0, 8000),
      status: map.status >= 0 ? mapStatus(cell(r, "status")) : "RECEBIDO",
      email: cell(r, "email"),
    });
  }
  return out;
}
