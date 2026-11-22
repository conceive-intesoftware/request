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
  pii_masked: boolean;
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
  comments: { id: string; body: string; created_at: string }[];
}

export interface ClinicAdmin {
  id: string;
  name: string;
  active: boolean;
  clinic_units: { id: string; name: string }[];
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
}

/** Subconjunto de File usado pelo upload (facilita testar fora do navegador). */
export interface UploadableFile {
  name: string;
  type: string;
  size: number;
}
