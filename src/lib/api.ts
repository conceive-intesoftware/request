import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditEntry,
  ClinicAdmin,
  ExternalTaskResult,
  ImportResult,
  NotifyLogRow,
  NotifyStatus,
  SimilarRequest,
  ImportRow,
  Metrics,
  PublicList,
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
type Client = Pick<SupabaseClient, "rpc" | "auth" | "storage" | "from"> & Partial<Pick<SupabaseClient, "functions">>;
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
  [/no_client_email/i, "Esta solicitação não tem e-mail do cliente cadastrado."],
  [/resend_limit/i, "Limite de 5 reenvios por dia para esta solicitação atingido. Tente amanhã."],
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
  [/email_required/i, "Informe o seu e-mail: é para ele que enviamos a confirmação e o link de acompanhamento."],
  [/notify_not_configured/i, "O banco ainda não está ligado à função de e-mail. Preencha v_notify_url e v_notify_secret na Parte B do SQL e rode o arquivo inteiro."],
  [/invalid_email/i, "E-mail inválido. Confira o endereço digitado."],
  [/invalid_vote/i, "Você já enviou este pedido, então ele já conta como o seu apoio."],
  [/not_rateable/i, "A avaliação só fica disponível depois que a solicitação é concluída."],
  [/invalid_score/i, "Escolha uma nota de 1 a 5."],
  [/closed_request/i, "Esta solicitação foi arquivada e não aceita mais respostas."],
  [/invalid_publish/i, "Não é possível publicar uma solicitação mesclada em outra."],
  [/too_many_rows/i, "Lote grande demais (máx. 200 linhas por envio)."],
  [/invalid_merge/i, "Não é possível mesclar estas solicitações."],
  [/invalid_system/i, "Sistema externo inválido."],
  [/user_not_found/i, "Este e-mail ainda não existe em Authentication → Users do Supabase. Crie o usuário lá primeiro."],
  [/unit_in_use/i, "Esta unidade já tem solicitações e não pode ser removida."],
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

async function uploadFiles(uid: string, files: UploadableFile[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const c = client();
  const paths: string[] = [];
  for (const [i, f] of files.entries()) {
    onProgress?.(i + 1, files.length);
    const path = `${uid}/${crypto.randomUUID()}__${safeName(f.name)}`;
    const { error } = await c.storage.from("attachments").upload(path, f as unknown as File, {
      contentType: f.type,
      upsert: false,
    });
    if (error) throw new ApiError(`Falha ao enviar o anexo “${f.name}”. Verifique o tipo e o tamanho (máx. 50 MB).`, error.message);
    paths.push(path);
  }
  return paths;
}

export async function submitRequest(
  input: SubmitInput,
  files: UploadableFile[] = [],
  onProgress?: (done: number, total: number) => void,
): Promise<{ protocol: string; trackingToken: string }> {
  const c = client();
  const { data: s } = await c.auth.getSession();
  if (!s.session) throw new ApiError("Sua sessão expirou. Recarregue a página e tente novamente.");
  const uid = s.session.user.id;

  const paths = await uploadFiles(uid, files, onProgress);

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
    p_requester_email: input.email?.trim() ? input.email.trim() : null,
  });
  const r = rows?.[0];
  if (!r) throw new ApiError("Resposta inesperada do servidor.");
  return { protocol: r.protocol, trackingToken: r.tracking_token };
}

export const getTracking = (token: string) => rpc<Tracking | null>("get_request_by_token", { p_token: token });

/** Resposta do cliente na página de acompanhamento (exige sessão anônima validada pelo CAPTCHA). */
export async function addClientComment(token: string, body: string, files: UploadableFile[] = [], onProgress?: (done: number, total: number) => void): Promise<string> {
  const { data: s } = await client().auth.getSession();
  if (!s.session) throw new ApiError("Sua sessão expirou. Recarregue a página e tente novamente.");
  const paths = await uploadFiles(s.session.user.id, files, onProgress);
  return rpc<string>("add_client_comment", { p_token: token, p_body: body, p_attachment_paths: paths });
}
export const rateRequest = (token: string, score: number, comment: string | null) =>
  rpc<null>("rate_request", { p_token: token, p_score: score, p_comment: comment?.trim() ? comment.trim() : null });

// roadmap público e votos
export const listPublicRequests = (search: string, module: string, page: number) =>
  rpc<PublicList>("list_public_requests", { p_search: search.trim() || null, p_module: module || null, p_page: page });
/** Pedidos já publicados no roadmap parecidos com o que está sendo digitado (não precisa de sessão). */
export const findSimilarRequests = (title: string, description: string) =>
  rpc<SimilarRequest[]>("find_similar_requests", { p_title: title, p_description: description || null });
export const voteRequest = (id: string) => rpc<number>("vote_request", { p_request_id: id });
export const unvoteRequest = (id: string) => rpc<number>("unvote_request", { p_request_id: id });

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
/** Comentário da equipe, com imagens/arquivos opcionais (ficam dentro do comentário, não na solicitação). */
export async function addComment(requestId: string, body: string, internal: boolean, files: UploadableFile[] = [], onProgress?: (done: number, total: number) => void): Promise<string> {
  let paths: string[] = [];
  if (files.length > 0) {
    const { data: s } = await client().auth.getSession();
    if (!s.session) throw new ApiError("Sua sessão expirou. Entre novamente.");
    paths = await uploadFiles(s.session.user.id, files, onProgress);
  }
  return rpc<string>("add_comment", { p_request_id: requestId, p_body: body, p_internal: internal, p_attachment_paths: paths });
}
export const archiveRequest = (id: string) => rpc<null>("archive_request", { p_id: id });
export const mergeRequest = (id: string, into: string) => rpc<null>("merge_request", { p_id: id, p_into: into });
export const unmergeRequest = (id: string) => rpc<null>("unmerge_request", { p_id: id });
export const linkClinic = (id: string, clinicId: string, unitId: string | null) =>
  rpc<null>("link_request_clinic", { p_id: id, p_clinic_id: clinicId, p_unit_id: unitId });
export const setExternalRef = (id: string, system: string, externalId: string) =>
  rpc<null>("set_external_ref", { p_id: id, p_system: system, p_external_id: externalId });
export const updateRequestFields = (id: string, fields: Record<string, string | null>) => rpc<null>("update_request_fields", { p_id: id, p_fields: fields });
export const setRequestPublic = (id: string, isPublic: boolean) => rpc<null>("set_request_public", { p_id: id, p_public: isPublic });
export const getMetrics = (days: number) => rpc<Metrics>("get_metrics", { p_days: days });
export const importRequests = (rows: ImportRow[]) => rpc<ImportResult>("admin_import_requests", { p_rows: rows });

/** Cria a tarefa no Redmine/Pipefy pela Edge Function "external-task" (usa o login da própria pessoa). */
export async function createExternalTask(requestId: string, system: "REDMINE" | "PIPEFY"): Promise<ExternalTaskResult> {
  const fns = client().functions;
  if (!fns) throw new ApiError("Integração indisponível neste ambiente.");
  const { data, error } = await fns.invoke("external-task", { body: { request_id: requestId, system } });
  if (error) {
    let detail = "";
    try { detail = JSON.stringify(await (error as { context?: Response }).context?.json()); } catch { /* sem corpo */ }
    const raw = `${error.message ?? ""} ${detail}`;
    if (/not_configured/.test(raw)) throw new ApiError(`A integração com ${system === "REDMINE" ? "o Redmine" : "o Pipefy"} ainda não foi configurada (veja o passo a passo).`, raw);
    if (/already_linked/.test(raw)) throw new ApiError("Esta solicitação já está vinculada a uma tarefa.", raw);
    if (/link_failed/.test(raw)) throw new ApiError("A tarefa foi criada, mas não deu para salvar o vínculo. Anote o ID e informe-o manualmente.", raw);
    throw new ApiError("Não foi possível criar a tarefa. Confira a configuração da integração.", raw);
  }
  return data as ExternalTaskResult;
}
export const exportRequests = (filters: Filters) =>
  rpc<Record<string, unknown>[]>("export_requests", { p_filters: clean(filters) });

export async function signedAttachmentUrl(path: string): Promise<string> {
  const { data, error } = await client().storage.from("attachments").createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw new ApiError("Não foi possível abrir o anexo.", error?.message);
  return data.signedUrl;
}

// ───────── administração ─────────
export const adminNotifyLog = (limit = 50) => rpc<NotifyLogRow[]>("admin_notify_log", { p_limit: limit });
/** Pede a leitura do status das tarefas no Redmine/Pipefy agora (o resultado chega em alguns segundos). */
export const adminSyncExternalNow = () => rpc<{ queued: boolean }>("admin_sync_external_now");
export const adminNotifyStatus = () => rpc<NotifyStatus>("admin_notify_status");
/** Envia um e-mail de teste (ao próprio Admin, ou a `to`) pela mesma rota dos e-mails reais. */
export const adminSendTestEmail = (to?: string) => rpc<{ to: string }>("admin_send_test_email", { p_to: to ?? null });
/** Reenvia ao cliente o e-mail com o link de acompanhamento e os dados da solicitação. Devolve o e-mail mascarado. */
export const adminResendRequestEmail = (id: string) => rpc<{ to: string }>("admin_resend_request_email", { p_id: id });
export const adminListStaff = () => rpc<StaffMember[]>("admin_list_staff");
export const adminUpsertStaff = (email: string, name: string, role: StaffRole, active: boolean) =>
  rpc<string>("admin_upsert_staff", { p_email: email, p_name: name, p_role: role, p_active: active });
export const adminGetSecurity = () => rpc<{ mfa_required: boolean }>("admin_get_security");
export const adminSetMfaRequired = (required: boolean) => rpc<null>("admin_set_mfa_required", { p_required: required });
export const adminSetUserMfa = (userId: string, exempt: boolean) => rpc<null>("admin_set_user_mfa", { p_user: userId, p_exempt: exempt });
export const adminResetMfa = (userId: string) => rpc<number>("admin_reset_mfa", { p_user: userId });
export const renameUnit = (unitId: string, name: string) => rpc<null>("admin_rename_unit", { p_unit_id: unitId, p_name: name });
export const deleteUnit = (unitId: string) => rpc<null>("admin_delete_unit", { p_unit_id: unitId });

const ADMIN_USERS_ERRORS: [RegExp, string][] = [
  [/email_exists/, "Já existe um usuário com este e-mail."],
  [/weak_password/, "A senha precisa ter ao menos 10 caracteres, com letras e números."],
  [/invalid_email/, "E-mail inválido."],
  [/invalid_name/, "Informe o nome (2 a 120 caracteres)."],
  [/invalid_role/, "Papel inválido."],
  [/staff_failed/, "O usuário foi criado no login, mas a liberação na equipe falhou. Libere o e-mail novamente na lista."],
  [/not_found/, "Este usuário não faz parte da equipe."],
  [/forbidden/, "Somente administradores podem fazer isto."],
  [/not_configured/, "A função admin-users não está configurada no Supabase (veja a Parte 6 do passo a passo)."],
];
async function invokeAdminUsers(body: Record<string, unknown>): Promise<{ user_id: string; email?: string; welcome?: "sent" | "failed" | "skipped" }> {
  const fns = client().functions;
  if (!fns) throw new ApiError("Esta função não está disponível neste ambiente.");
  const { data, error } = await fns.invoke("admin-users", { body });
  if (error) {
    let detail = "";
    try { detail = JSON.stringify(await (error as { context?: Response }).context?.json()); } catch { /* sem corpo */ }
    const raw = `${error.message ?? ""} ${detail}`;
    for (const [re, msg] of ADMIN_USERS_ERRORS) if (re.test(raw)) throw new ApiError(msg, raw);
    throw new ApiError("Não foi possível concluir. Confirme se a função admin-users foi publicada no Supabase (veja a Parte 6 do passo a passo).", raw);
  }
  return data as { user_id: string; email?: string; welcome?: "sent" | "failed" | "skipped" };
}
/** Cria o usuário (login) e já o libera na equipe. Senha: 10+ caracteres com letras e números. */
export const createStaffUser = (input: { email: string; name: string; role: StaffRole; password: string; send_welcome?: boolean; include_password?: boolean }) =>
  invokeAdminUsers({ action: "create", ...input });
export const setStaffPassword = (userId: string, password: string) => invokeAdminUsers({ action: "set_password", user_id: userId, password });
/** Troca a senha de quem está logado. */
export async function changeMyPassword(password: string): Promise<void> {
  const { error } = await client().auth.updateUser({ password });
  if (error) throw new ApiError(/weak|short|characters|password/i.test(error.message) ? "A senha precisa ter ao menos 10 caracteres, com letras e números." : "Não foi possível trocar a senha. Entre novamente e tente de novo.", error.message);
}
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
