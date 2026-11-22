// Os valores (1ª coluna) DEVEM ser idênticos aos enums do banco.
// O teste tests/unit.test.ts compara estas listas com a migração SQL.

export type Opt = readonly [value: string, label: string];

export const REQUESTER_ROLES: readonly Opt[] = [
  ["DONO_SOCIO", "Dono/Sócio"],
  ["ADMINISTRADOR", "Administrador"],
  ["RECEPCIONISTA", "Recepcionista"],
  ["MEDICO", "Médico"],
  ["ENFERMEIRO", "Enfermeiro"],
  ["FARMACEUTICO", "Farmacêutico"],
  ["CONTADOR", "Contador"],
  ["OUTRO", "Outro"],
];

export const MODULES: readonly Opt[] = [
  ["FINANCEIRO", "Financeiro"],
  ["AGENDA", "Agenda"],
  ["PRONTUARIO", "Prontuário"],
  ["ESTOQUE_FARMACIA", "Estoque/Farmácia"],
  ["FATURAMENTO_TISS", "Faturamento TISS"],
  ["OUTRO", "Outro"],
];

export const TYPES: readonly Opt[] = [
  ["NOVA_FUNCIONALIDADE", "Nova funcionalidade"],
  ["MELHORIA_FLUXO", "Melhoria de fluxo"],
  ["SUGESTAO_TECNICA", "Sugestão técnica"],
];

export const STATUSES: readonly Opt[] = [
  ["RECEBIDO", "Recebido"],
  ["EM_ANALISE_PRODUTO", "Em análise de produto"],
  ["APROVADO_ROADMAP", "Aprovado para roadmap"],
  ["EM_DESENVOLVIMENTO", "Em desenvolvimento"],
  ["CONCLUIDO", "Concluído"],
  ["ARQUIVADO", "Arquivado"],
];

export const PRIORITIES: readonly Opt[] = [
  ["BAIXA", "Baixa"],
  ["MEDIA", "Média"],
  ["ALTA", "Alta"],
  ["CRITICA", "Crítica"],
];

export const STAFF_ROLES: readonly Opt[] = [
  ["ADMIN", "Admin"],
  ["PO", "Product Owner"],
  ["SUPPORT", "Suporte / CS"],
  ["DEV_VIEWER", "Dev (visualizador)"],
];

export const labelOf = (list: readonly Opt[], value: string | null | undefined): string =>
  list.find(([k]) => k === value)?.[1] ?? value ?? "—";

export const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "application/pdf", "video/mp4", "video/webm"];
export const MAX_FILE_MB = 25;
export const MAX_FILES = 5;
