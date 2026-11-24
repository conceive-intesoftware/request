export type StaffRole = "ADMIN" | "PO" | "SUPPORT" | "DEV_VIEWER";

export interface Ctx {
  uid: string | null;
  role: StaffRole | null; // null = sem papel de equipe (ou sem MFA)
  name: string | null;
  aal: string | null;
  is_anonymous: boolean;
  permissions: string[];
}

export interface Filters {
  q?: string;
  clinic_id?: string;
  requester_role?: string;
  module?: string;
  status?: string;
  priority?: string;
  from?: string;
  to?: string;
  sla?: string;
}

export interface ListRow {
  id: string;
  protocol: string;
  title: string;
  status: string;
  priority: string;
  module: string;
  type: string;
  requester_name: string;
  requester_role: string;
  whatsapp: string;
  pii_masked: boolean;
  clinic_id: string | null;
  clinic_name: string | null;
  pending_clinic_name: string | null;
  rice_score: number | null;
  merged_into_id: string | null;
  duplicates_count: number;
  is_public: boolean;
  csat_score: number | null;
  votes: number;
  awaiting_reply: boolean;
  sla: "SEM_RESPOSTA" | "PARADA" | null;
  created_at: string;
}

export interface ListResult {
  total: number;
  page: number;
  page_size: number;
  rows: ListRow[];
}

export interface AuditEntry {
  id: number;
  action: "CREATE" | "UPDATE" | "DELETE" | "EXPORT" | "LOGIN" | "VIEW_SENSITIVE";
  entity: string;
  created_at: string;
  ip: string | null;
  user_agent: string | null;
  user: string;
  previous: Record<string, unknown> | null;
  next: Record<string, unknown> | null;
}

export interface Detail {
  id: string;
  protocol: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  module: string;
  type: string;
  requester_name: string;
  requester_role: string;
  whatsapp: string;
  requester_email: string | null;
  pii_masked: boolean;
  is_public: boolean;
  origin: "FORM" | "IMPORT";
  votes: number;
  csat: { score: number | null; comment: string | null; at: string | null };
  completed_at: string | null;
  clinic_id: string | null;
  clinic_name: string | null;
  unit_name: string | null;
  pending_clinic_name: string | null;
  rice: { reach: number | null; impact: number | null; confidence: number | null; effort: number | null; score: number | null };
  external_system: string | null;
  external_id: string | null;
  merged_into: { id: string; protocol: string } | null;
  created_at: string;
  updated_at: string;
  attachments: { id: string; file_name: string; mime_type: string; size_bytes: number; storage_path: string }[];
  comments: {
    id: string;
    body: string;
    is_internal: boolean;
    created_at: string;
    author_name: string | null;
    author_role: string | null;
    author_kind: "STAFF" | "CLIENT";
  }[];
  duplicates: { id: string; protocol: string; title: string; clinic_name: string | null }[];
  tags: string[];
  audit: AuditEntry[] | null;
}

export interface Tracking {
  protocol: string;
  title: string;
  status: string;
  module: string;
  type: string;
  created_at: string;
  updated_at: string;
  has_email: boolean;
  csat_score: number | null;
  csat_comment: string | null;
  comments: { id: string; body: string; created_at: string; from_client: boolean }[];
}

export interface ClinicAdmin {
  id: string;
  name: string;
  active: boolean;
  clinic_units: { id: string; name: string }[];
}

export interface NotifyLogRow {
  id: number;
  created_at: string;
  event: string;
  protocol: string | null;
  outcome: "ENFILEIRADO" | "ERRO";
  detail: string | null;
  http_status: number | null;
  http_error: string | null;
}

export interface StaffMember {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  active: boolean;
}

export interface SubmitInput {
  clinicId: string | null;
  unitId: string | null;
  pendingClinicName: string | null;
  requesterName: string;
  requesterRole: string;
  whatsapp: string;
  module: string;
  type: string;
  title: string;
  description: string;
  email?: string | null;
}

/** Subconjunto de File usado pelo upload (facilita testar fora do navegador). */
export interface UploadableFile {
  name: string;
  type: string;
  size: number;
}

export interface PublicRow {
  id: string;
  protocol: string;
  title: string;
  excerpt: string;
  module: string;
  type: string;
  status: string;
  created_at: string;
  votes: number;
  voted_by_me: boolean;
  mine: boolean;
}
export interface PublicList {
  total: number;
  page: number;
  page_size: number;
  rows: PublicRow[];
}

export interface Metrics {
  days: number;
  total: number;
  open: number;
  completed: number;
  completion_rate: number | null;
  awaiting_reply: number;
  stalled: number;
  avg_first_response_hours: number | null;
  avg_resolution_days: number | null;
  by_status: { key: string; count: number }[];
  by_module: { key: string; count: number }[];
  by_type: { key: string; count: number }[];
  top_clinics: { name: string; count: number }[];
  weekly: { week: string; created: number; completed: number }[];
  csat: { count: number; avg: number | null; distribution: { score: number; count: number }[] };
  votes_total: number;
  top_voted: { protocol: string; title: string; votes: number }[];
}

/** Linha já normalizada para a importação (enums válidos do banco). */
export interface ImportRow {
  key: string;
  created_at: string | null;
  clinic: string;
  unit: string;
  name: string;
  role: string;
  whatsapp: string;
  module: string;
  type: string;
  title: string;
  description: string;
  status: string;
  email: string;
}
export interface ImportResult {
  inserted: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}
export interface ExternalTaskResult {
  system: "REDMINE" | "PIPEFY";
  id: string;
  url?: string;
}
