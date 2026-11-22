import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditEntry,
  ClinicAdmin,
  Ctx,
  Detail,
  Filters,
  ListResult,
  StaffMember,
  StaffRole,
  SubmitInput,
  Tracking,
  UploadableFile,
} from "./types";

// ───────── cliente injetável (o app usa o Supabase real; os testes usam um cliente falso) ─────────
type Client = Pick<SupabaseClient, "rpc" | "auth" | "storage" | "from">;
let _client: Client | null = null;
export function setClient(c: unknown) {
  _client = c as Client;
}
export function client(): Client {
  if (!_client) throw new ApiError("Supabase não configurado.");
  return _client;
}

// ───────── erros amigáveis ─────────
export class ApiError extends Error {
  raw?: string;
  constructor(message: string, raw?: string) {
    super(message);
    this.name = "ApiError";
    this.raw = raw;
  }
}

const FRIENDLY: [RegExp, string][] = [
  [/rate_limited/i, "Muitas solicitações em pouco tempo. Aguarde alguns minutos e tente novamente."],
  [/invalid_phone/i, "WhatsApp inválido. Use o formato (84) 99999-9999."],
  [/invalid_name/i, "Informe seu nome completo."],
  [/invalid_title/i, "Título inválido (5 a 140 caracteres)."],
  [/invalid_description/i, "Descrição inválida (20 a 8000 caracteres)."],
  [/clinic_required/i, "Selecione a clínica ou informe o nome dela."],
  [/invalid_clinic/i, "Clínica inválida ou inativa."],
  [/too_many_attachments/i, "No máximo 5 anexos."],
  [/invalid_attachment/i, "Anexo inválido. Envie o arquivo novamente."],
  [/invalid_comment/i, "Comentário vazio ou grande demais (máx. 4000)."],
  [/invalid_merge/i, "Não é possível mesclar estas solicitações."],
  [/invalid_system/i, "Sistema externo inválido."],
  [/user_not_found/i, "Este e-mail ainda não existe em Authentication → Users do Supabase. Crie o usuário lá primeiro."],
  [/last_admin/i, "Não é possível rebaixar/desativar o último administrador."],
  [/not_found/i, "Registro não encontrado (pode ter sido arquivado)."],
  [/forbidden|permission denied|not_authenticated|jwt/i, "Você não tem permissão para esta ação, ou sua sessão expirou."],
  [/duplicate key|unique/i, "Já existe um registro com esse nome."],
  [/violates check constraint/i, "Algum valor está fora do permitido."],
  [/invalid input value/i, "Valor inválido."],
];

export function friendlyMessage(raw: string): string {
  for (const [re, msg] of FRIENDLY) if (re.test(raw)) return msg;
  return "Não foi possível concluir a operação. Tente novamente.";
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client().rpc(fn, args);
  if (error) throw new ApiError(friendlyMessage(error.message ?? ""), error.message);
  return data as T;
}

// ───────── sessão anônima (cliente final) ─────────
/** Garante uma sessão (anônima, protegida por Turnstile no Supabase Auth). Devolve o uid. */
export async function ensureSession(captchaToken?: string): Promise<string> {
  const c = client();
  const { data } = await c.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: d, error } = await c.auth.signInAnonymously(
    captchaToken ? { options: { captchaToken } } : undefined,
  );
  if (error || !d?.user) {
    throw new ApiError("Não foi possível validar a verificação anti-robô. Recarregue a página e tente de novo.", error?.message);
  }
  return d.user.id;
}

export async function hasSession(): Promise<boolean> {
  const { data } = await client().auth.getSession();
  return !!data.session;
}

// ───────── público ─────────
export const searchClinics = (q: string) => rpc<{ id: string; name: string }[]>("search_clinics", { p_query: q });
export const listUnits = (clinicId: string) => rpc<{ id: string; name: string }[]>("list_units", { p_clinic_id: clinicId });

const safeName = (n: string) =>
  n.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "arquivo";

export async function submitRequest(
  input: SubmitInput,
  files: UploadableFile[] = [],
): Promise<{ protocol: string; trackingToken: string }> {
  const c = client();
  const { data: s } = await c.auth.getSession();
  if (!s.session) throw new ApiError("Sua sessão expirou. Recarregue a página e tente novamente.");
  const uid = s.session.user.id;

  const paths: string[] = [];
  for (const f of files) {
    const path = `${uid}/${crypto.randomUUID()}__${safeName(f.name)}`;
    const { error } = await c.storage.from("attachments").upload(path, f as unknown as File, {
      contentType: f.type,
      upsert: false,
    });
    if (error) throw new ApiError(`Falha ao enviar o anexo “${f.name}”. Verifique o tipo e o tamanho (máx. 25 MB).`, error.message);
    paths.push(path);
  }

  const rows = await rpc<{ protocol: string; tracking_token: string }[]>("submit_request", {
    p_clinic_id: input.clinicId,
    p_unit_id: input.unitId,
    p_pending_clinic_name: input.pendingClinicName,
    p_requester_name: input.requesterName,
    p_requester_role: input.requesterRole,
    p_whatsapp: input.whatsapp,
    p_module: input.module,
    p_type: input.type,
    p_title: input.title,
    p_description: input.description,
    p_attachment_paths: paths,
  });
  const r = rows?.[0];
  if (!r) throw new ApiError("Resposta inesperada do servidor.");
  return { protocol: r.protocol, trackingToken: r.tracking_token };
}

export const getTracking = (token: string) => rpc<Tracking | null>("get_request_by_token", { p_token: token });

// ───────── equipe ─────────
export const myContext = () => rpc<Ctx>("my_context");
export const logLogin = () => rpc<null>("log_login");

export const listRequests = (filters: Filters, page = 1, pageSize = 25) =>
  rpc<ListResult>("list_requests", { p_filters: clean(filters), p_page: page, p_page_size: pageSize });
export const getRequestDetail = (id: string) => rpc<Detail | null>("get_request_detail", { p_id: id });
export const setStatus = (id: string, status: string) => rpc<null>("set_request_status", { p_id: id, p_status: status });
export const setPriority = (
  id: string,
  priority: string,
  reach: number,
  impact: number,
  confidence: number,
  effort: number,
) =>
  rpc<number>("set_request_priority", {
    p_id: id,
    p_priority: priority,
    p_reach: reach,
    p_impact: impact,
    p_confidence: confidence,
    p_effort: effort,
  });
export const setTags = (id: string, tags: string[]) => rpc<null>("set_request_tags", { p_id: id, p_tags: tags });
export const addComment = (requestId: string, body: string, internal: boolean) =>
  rpc<string>("add_comment", { p_request_id: requestId, p_body: body, p_internal: internal });
export const archiveRequest = (id: string) => rpc<null>("archive_request", { p_id: id });
export const mergeRequest = (id: string, into: string) => rpc<null>("merge_request", { p_id: id, p_into: into });
export const unmergeRequest = (id: string) => rpc<null>("unmerge_request", { p_id: id });
export const linkClinic = (id: string, clinicId: string, unitId: string | null) =>
  rpc<null>("link_request_clinic", { p_id: id, p_clinic_id: clinicId, p_unit_id: unitId });
export const setExternalRef = (id: string, system: string, externalId: string) =>
  rpc<null>("set_external_ref", { p_id: id, p_system: system, p_external_id: externalId });
export const exportRequests = (filters: Filters) =>
  rpc<Record<string, unknown>[]>("export_requests", { p_filters: clean(filters) });

export async function signedAttachmentUrl(path: string): Promise<string> {
  const { data, error } = await client().storage.from("attachments").createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw new ApiError("Não foi possível abrir o anexo.", error?.message);
  return data.signedUrl;
}

// ───────── administração ─────────
export const adminListStaff = () => rpc<StaffMember[]>("admin_list_staff");
export const adminUpsertStaff = (email: string, name: string, role: StaffRole, active: boolean) =>
  rpc<string>("admin_upsert_staff", { p_email: email, p_name: name, p_role: role, p_active: active });
export const upsertClinic = (id: string | null, name: string, active: boolean) =>
  rpc<string>("admin_upsert_clinic", { p_id: id, p_name: name, p_active: active });
export const addUnit = (clinicId: string, name: string) =>
  rpc<string>("admin_add_unit", { p_clinic_id: clinicId, p_name: name });

export async function listClinicsAdmin(): Promise<ClinicAdmin[]> {
  const { data, error } = await client()
    .from("clinics")
    .select("id,name,active,clinic_units(id,name)")
    .order("name");
  if (error) throw new ApiError(friendlyMessage(error.message), error.message);
  return (data ?? []) as unknown as ClinicAdmin[];
}

function clean(f: Filters): Filters {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  return out;
}

export type { AuditEntry };
