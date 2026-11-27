// Edge Function "notify" — envia e-mails do Conceive pelo Resend.
// Chamada SOMENTE pelo banco (pg_net), com o cabeçalho x-webhook-secret. Cole este arquivo inteiro no
// editor de Edge Functions do Supabase (nome da função: notify) e DESLIGUE "Verify JWT" nela.
//
// Segredos (Edge Functions → Secrets):
//   WEBHOOK_SECRET   texto longo e aleatório (o mesmo guardado no banco)
//   MAIL_PROVIDER    (opcional) "resend" (padrão), "brevo" ou "apps_script" (envio pelo Gmail, sem domínio próprio)
//   RESEND_API_KEY   chave da API do Resend (re_...)               — só com MAIL_PROVIDER=resend
//   BREVO_API_KEY    chave da API do Brevo (xkeysib-...)           — só com MAIL_PROVIDER=brevo
//   APPS_SCRIPT_URL / APPS_SCRIPT_SECRET   URL /exec e senha do script supabase/apps-script/Code.gs — só com MAIL_PROVIDER=apps_script
//                    (neste caso MAIL_FROM é opcional: só o nome de exibição é usado; o remetente é a conta Google do script)
//   MAIL_FROM        ex.: Conceive <solicitacoes@seudominio.com.br>. Resend: domínio verificado. Brevo: remetente validado
//                    (pode ser um e-mail simples, como o do Hotmail, validado em Brevo → Senders)
//   SITE_URL         endereço do site, ex.: https://usuario.github.io/conceive-requests/
//   TEAM_EMAILS      (opcional) e-mails da equipe, separados por vírgula
//   REPLY_TO         (opcional) endereço que recebe as respostas dos clientes (cabeçalho Reply-To)
//
// Eventos aceitos (JSON): request_created, request_resend (reenvio ao cliente, botão do painel), status_changed (só etapas relevantes),
// staff_welcome (boas-vindas a novo usuário da equipe, disparado pela função admin-users), sla_digest (resumo diário da equipe)
// e test (e-mail de teste, disparado pelo botão do painel Equipe → E-mails automáticos).
// Em caso de erro a resposta traz o motivo (campos reason / missing / provider_status / provider_message / hint): o painel os exibe.

declare const Deno: any;

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: any) => Promise<{ ok: boolean; status: number; json?: () => Promise<any>; text?: () => Promise<string> }>;

const MODULES: Record<string, string> = {
  FINANCEIRO: "Financeiro", AGENDA: "Agenda", PRONTUARIO: "Prontuário", ESTOQUE_FARMACIA: "Estoque/Farmácia",
  FATURAMENTO_TISS: "Faturamento TISS", OUTRO: "Outro",
};
const TYPES: Record<string, string> = {
  NOVA_FUNCIONALIDADE: "Nova funcionalidade", MELHORIA_FLUXO: "Melhoria de fluxo", SUGESTAO_TECNICA: "Sugestão técnica",
};
const STATUSES: Record<string, string> = {
  RECEBIDO: "Recebido", EM_ANALISE_PRODUTO: "Em análise de produto", APROVADO_ROADMAP: "Aprovado para roadmap",
  EM_DESENVOLVIMENTO: "Em desenvolvimento", CONCLUIDO: "Concluído", ARQUIVADO: "Arquivado",
};
const label = (map: Record<string, string>, v: unknown) => (typeof v === "string" ? map[v] ?? v : "—");

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const oneLine = (s: unknown, max = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const validEmail = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v.trim());
const TOKEN_RE = /^[0-9a-f]{48}$/;
const APPS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_RE = /^[0-9A-Za-z-]{8,64}$/;

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** "Nome <a@b.com>" ou "a@b.com" → { name?, email } (o Brevo recebe os dois campos separados). */
function parseFrom(v: string | undefined): { name?: string; email: string } | null {
  const m = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(v ?? "") ?? /^\s*()([^<>\s]+)\s*$/.exec(v ?? "");
  if (!m || !validEmail(m[2])) return null;
  return { ...(m[1]?.trim() ? { name: m[1].trim() } : {}), email: m[2].trim() };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Mail { to: string[]; subject: string; html: string; text: string }

/** Endereço-base do site, sempre terminado em "/". Corta "#/..." e "?..." colados por engano e "index.html"; exige https (ou localhost). */
function normalizeSite(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().split("#")[0].split("?")[0].replace(/index\.html$/i, "").trim();
  if (!v) return null;
  if (!/^https:\/\/[^\s/]+(\/\S*)?$/i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(v)) return null;
  return v.replace(/\/*$/, "/");
}

/** Link do painel que já abre a solicitação (só funciona para quem tem login de equipe). */
function adminLink(site: string, id: unknown): string {
  return typeof id === "string" && UUID_RE.test(id) ? `${site}#/admin?abrir=${id.toLowerCase()}` : `${site}#/admin`;
}

/** Data e hora no fuso de Fortaleza, em português (ex.: 25/11/2026 às 00:25). */
function fmtDateTime(v: unknown): string {
  const d = new Date(String(v ?? ""));
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} às ${g("hour")}:${g("minute")}`;
}

// ───────────────────────── Modelo visual dos e-mails ─────────────────────────
// Estrutura em tabelas e estilos inline (único formato que Gmail, Outlook e Hotmail renderizam de forma confiável).
const C = { brand: "#3b1678", accent: "#6d28d9", bg: "#f3f2f8", card: "#ffffff", text: "#1d1b26", muted: "#6b6880", line: "#e3e0ee", soft: "#f8f7fc" };
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

interface Button { url: string; text: string }
interface LayoutOpts {
  preheader: string;          // texto de pré-visualização da caixa de entrada (fica oculto no corpo)
  heading: string;
  eyebrow?: string;           // rótulo pequeno acima do título (ex.: "Confirmação")
  body: string;               // HTML do corpo
  button?: Button;
  signature?: boolean;        // "Atenciosamente, Equipe Conceive"
  audience: "client" | "team";
  replyable: boolean;
}

function layout(o: LayoutOpts): string {
  const btn = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px"><tr><td style="background:${C.accent};border-radius:8px">
         <a href="${esc(o.button.url)}" style="display:inline-block;padding:14px 28px;font:600 15px ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${esc(o.button.text)}</a></td></tr></table>
       <p style="margin:14px 0 0;font:13px/1.5 ${FONT};color:${C.muted}">Se o botão não abrir, copie e cole este endereço no navegador:<br><a href="${esc(o.button.url)}" style="color:${C.accent};word-break:break-all">${esc(o.button.url)}</a></p>`
    : "";
  const sign = o.signature
    ? `<p style="margin:28px 0 0;font:15px/1.6 ${FONT};color:${C.text}">Atenciosamente,<br><strong>Equipe Conceive</strong><br><span style="color:${C.muted};font-size:13px">Central de Solicitações</span></p>`
    : "";
  const reply = o.replyable ? "Em caso de dúvidas, basta responder a este e-mail." : "Esta é uma mensagem automática; não é necessário respondê-la.";
  const why = o.audience === "client"
    ? "Você recebeu este e-mail porque seu endereço foi informado em uma solicitação registrada na Central de Solicitações Conceive."
    : "Você recebeu este e-mail por fazer parte da equipe da Central de Solicitações Conceive.";
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.bg}">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
    <tr><td style="background:${C.brand};border-radius:14px 14px 0 0;padding:22px 32px">
      <span style="font:700 20px ${FONT};color:#ffffff;letter-spacing:.2px">Conceive</span>
      <span style="font:13px ${FONT};color:#d9ccf5"> &nbsp;|&nbsp; Central de Solicitações</span>
    </td></tr>
    <tr><td style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 14px 14px;padding:32px">
      ${o.eyebrow ? `<p style="margin:0 0 6px;font:700 12px ${FONT};letter-spacing:1px;text-transform:uppercase;color:${C.accent}">${esc(o.eyebrow)}</p>` : ""}
      <h1 style="margin:0 0 18px;font:700 24px/1.3 ${FONT};color:${C.text}">${esc(o.heading)}</h1>
      <div style="font:15px/1.6 ${FONT};color:${C.text}">${o.body}</div>
      ${btn}${sign}
    </td></tr>
    <tr><td style="padding:20px 8px 0;font:12px/1.6 ${FONT};color:${C.muted};text-align:center">
      ${esc(reply)}<br>${esc(why)}<br>Os dados pessoais são tratados em conformidade com a Lei Geral de Proteção de Dados (LGPD).
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

/** Quadro de dados (rótulo/valor) com destaque suave. */
function details(rows: [string, string][]): string {
  const tr = rows.filter(([, v]) => v !== "").map(([k, v], i, a) =>
    `<tr><td style="padding:10px 16px;width:38%;font:13px ${FONT};color:${C.muted};vertical-align:top;${i < a.length - 1 ? `border-bottom:1px solid ${C.line}` : ""}">${esc(k)}</td>
       <td style="padding:10px 16px;font:600 14px ${FONT};color:${C.text};${i < a.length - 1 ? `border-bottom:1px solid ${C.line}` : ""}">${esc(v)}</td></tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;background:${C.soft};border:1px solid ${C.line};border-radius:10px;border-collapse:separate">${tr}</table>`;
}
const detailsText = (rows: [string, string][]) => rows.filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`).join("\n");

/** Barra de progresso das etapas (Recebido → Concluído). `current` = código da etapa atual. */
const FLOW = ["RECEBIDO", "EM_ANALISE_PRODUTO", "APROVADO_ROADMAP", "EM_DESENVOLVIMENTO", "CONCLUIDO"];
function progress(current: unknown): string {
  const idx = FLOW.indexOf(String(current));
  if (idx < 0) return "";
  const cells = FLOW.map((s, i) => {
    const on = i <= idx;
    return `<td style="width:20%;padding:0 2px;vertical-align:top"><div style="height:6px;border-radius:3px;background:${on ? C.accent : C.line}"></div>
      <div style="padding-top:6px;font:${i === idx ? "700" : "400"} 11px/1.3 ${FONT};color:${i === idx ? C.text : C.muted}">${esc(STATUSES[s])}</div></td>`;
  }).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr>${cells}</tr></table>`;
}

const para = (t: string) => `<p style="margin:0 0 14px">${t}</p>`;
const note = (t: string) => `<p style="margin:16px 0 0;padding:12px 14px;background:${C.soft};border-left:4px solid ${C.accent};border-radius:4px;font:14px/1.5 ${FONT}">${t}</p>`;

const ROLE_LABEL: Record<string, string> = { ADMIN: "Administrador", PO: "Product Owner", SUPPORT: "Suporte / CS", DEV_VIEWER: "Desenvolvedor (somente leitura)" };
const ROLE_DESC: Record<string, string> = {
  ADMIN: "Acesso completo: solicitações, clínicas, usuários, relatórios e configurações.",
  PO: "Gerencia solicitações, etapas, roadmap, relatórios e respostas ao cliente.",
  SUPPORT: "Registra o atendimento e responde aos clientes; dados pessoais visíveis.",
  DEV_VIEWER: "Consulta as solicitações com dados pessoais ocultos (LGPD), sem alterá-las.",
};

/** Mensagens por etapa enviadas ao cliente (somente etapas que realmente importam). */
const STATUS_COPY: Record<string, { subject: string; heading: string; lead: string }> = {
  EM_ANALISE_PRODUTO: { subject: "Sua solicitação está em análise", heading: "Sua solicitação está em análise", lead: "Nossa equipe de produto iniciou a análise da sua solicitação. Avisaremos você assim que houver uma nova etapa." },
  APROVADO_ROADMAP: { subject: "Sua solicitação foi aprovada para o roadmap", heading: "Solicitação aprovada para o roadmap", lead: "Boa notícia: sua solicitação foi aprovada e entrou no planejamento de evolução do sistema." },
  EM_DESENVOLVIMENTO: { subject: "Sua solicitação entrou em desenvolvimento", heading: "Sua solicitação está em desenvolvimento", lead: "Sua solicitação já está sendo desenvolvida pela nossa equipe técnica." },
  CONCLUIDO: { subject: "Sua solicitação foi concluída", heading: "Sua solicitação foi concluída", lead: "Concluímos o atendimento da sua solicitação. Obrigado por contribuir com a evolução do sistema." },
};
/** Etapas que geram e-mail ao cliente. As demais (voltar para "Recebido", arquivar) são movimentos internos e não são avisadas. */
export const NOTIFY_STATUSES = Object.keys(STATUS_COPY);

function buildMails(p: any, env: Env): Mail[] {
  const site = normalizeSite(env.SITE_URL) ?? "";
  const link = typeof p.tracking_token === "string" && TOKEN_RE.test(p.tracking_token) ? `${site}#/acompanhar/${p.tracking_token}` : null;
  const client = validEmail(p.client_email) && link ? [p.client_email.trim()] : [];
  const team = (env.TEAM_EMAILS ?? "").split(",").map((s) => s.trim()).filter(validEmail).slice(0, 50);
  const proto = oneLine(p.protocol, 40);
  const title = oneLine(p.title, 140);
  const mails: Mail[] = [];
  const replyable = validEmail(env.REPLY_TO);
  const panel = adminLink(site, p.request_id);
  const clientLayout = (o: Omit<LayoutOpts, "audience" | "replyable">) => layout({ ...o, audience: "client", replyable });
  const teamLayout = (o: Omit<LayoutOpts, "audience" | "replyable" | "signature">) => layout({ ...o, audience: "team", replyable });

  const nome = oneLine(p.requester_name, 120);
  const greet = nome ? `Prezado(a) ${nome},` : "Prezado(a) cliente,";
  const summary = (situacao: string): [string, string][] => [
    ["Protocolo", proto], ["Assunto", title], ["Clínica", oneLine(p.clinic_name || "", 160)],
    ["Módulo", label(MODULES, p.module)], ["Tipo de demanda", label(TYPES, p.type)],
    ["Registrada em", fmtDateTime(p.created_at)], ["Situação atual", situacao],
  ];
  const tail = "Guarde este e-mail: o link é pessoal e é a única forma de acompanhar a solicitação, pois não há login para clientes. Não o compartilhe com terceiros.";

  /** Confirmação ao cliente. `resend` = reenvio pedido pela equipe (mostra a etapa atual e o progresso). */
  const confirmation = (resend: boolean): Mail => {
    const situacao = resend ? label(STATUSES, p.status) : "Recebido";
    const rows = summary(situacao);
    const lead = resend
      ? `A pedido da nossa equipe, reenviamos as informações da sua solicitação, registrada sob o protocolo <strong>${esc(proto)}</strong>.`
      : `Confirmamos o recebimento da sua solicitação, registrada sob o protocolo <strong>${esc(proto)}</strong>. Nossa equipe fará a análise e retornará por este canal.`;
    const leadTxt = resend
      ? `A pedido da nossa equipe, reenviamos as informações da sua solicitação, registrada sob o protocolo ${proto}.`
      : `Confirmamos o recebimento da sua solicitação, registrada sob o protocolo ${proto}. Nossa equipe fará a análise e retornará por este canal.`;
    return {
      to: client,
      subject: resend ? `[${proto}] Reenvio: informações e link de acompanhamento` : `[${proto}] Confirmação de recebimento da sua solicitação`,
      html: clientLayout({
        preheader: `Protocolo ${proto}. Guarde o link para acompanhar o andamento.`,
        eyebrow: resend ? "Reenvio de informações" : "Confirmação de recebimento",
        heading: resend ? "Informações da sua solicitação" : "Recebemos a sua solicitação",
        body: para(esc(greet)) + para(lead) + details(rows) + progress(resend ? p.status : "RECEBIDO")
          + para("Para consultar o andamento, enviar informações complementares ou avaliar o atendimento, utilize o botão abaixo.")
          + note("<strong>Guarde este e-mail.</strong> O link é pessoal e é a única forma de acompanhar a solicitação, pois não há login para clientes. Não o compartilhe com terceiros."),
        button: { url: link!, text: "Acompanhar solicitação" }, signature: true,
      }),
      text: `${greet}\n\n${leadTxt}\n\n${detailsText(rows)}\n\nPara consultar o andamento, enviar informações complementares ou avaliar o atendimento, acesse:\n${link}\n\n${tail}\n\nAtenciosamente,\nEquipe Conceive\nCentral de Solicitações\n`,
    };
  };

  switch (p.event) {
    case "request_resend": {
      if (client.length && link) mails.push(confirmation(true));
      break;
    }
    case "request_created": {
      if (client.length && link) mails.push(confirmation(false));
      if (team.length) {
        const rows: [string, string][] = [["Protocolo", proto], ["Título", title], ["Clínica", oneLine(p.clinic_name || "", 160)], ["Módulo", label(MODULES, p.module)], ["Tipo de demanda", label(TYPES, p.type)], ["Registrada em", fmtDateTime(p.created_at)]];
        mails.push({
          to: team,
          subject: `[${proto}] Nova solicitação: ${title}`,
          html: teamLayout({
            preheader: `${title} (${label(MODULES, p.module)})`, eyebrow: "Nova solicitação", heading: "Uma nova solicitação aguarda análise",
            body: para("Uma nova solicitação foi registrada pelo formulário público e está na etapa <strong>Recebido</strong>.") + details(rows),
            button: { url: panel, text: "Abrir no painel" },
          }),
          text: `Uma nova solicitação foi registrada pelo formulário público (etapa: Recebido).\n\n${detailsText(rows)}\n\nAbrir no painel: ${panel}\n`,
        });
      }
      break;
    }
    case "status_changed": {
      const copy = STATUS_COPY[String(p.status)];
      if (client.length && link && copy) {
        const st = label(STATUSES, p.status), prev = label(STATUSES, p.previous_status);
        const rows: [string, string][] = [["Protocolo", proto], ["Assunto", title], ["Etapa anterior", prev], ["Etapa atual", st]];
        const done = p.status === "CONCLUIDO";
        const extra = done ? para("Sua opinião é muito importante para nós. Leva menos de um minuto: abra a página de acompanhamento e atribua uma nota de 1 a 5 estrelas ao atendimento.") : para("Você pode acompanhar o histórico completo e enviar informações complementares pelo botão abaixo.");
        mails.push({
          to: client,
          subject: `[${proto}] ${copy.subject}`,
          html: clientLayout({
            preheader: `${copy.heading}. Protocolo ${proto}.`, eyebrow: "Atualização de etapa", heading: copy.heading,
            body: para(esc(greet)) + para(esc(copy.lead)) + details(rows) + progress(p.status) + extra,
            button: { url: link, text: done ? "Avaliar o atendimento" : "Acompanhar solicitação" }, signature: true,
          }),
          text: `${greet}\n\n${copy.lead}\n\n${detailsText(rows)}\n\n${done ? "Avalie o atendimento com uma nota de 1 a 5 estrelas" : "Acompanhe o histórico completo"} em:\n${link}\n\nAtenciosamente,\nEquipe Conceive\nCentral de Solicitações\n`,
        });
      }
      break;
    }
    case "staff_welcome": {
      const to = validEmail(p.staff_email) ? [p.staff_email.trim()] : [];
      if (to.length && site) {
        const sname = oneLine(p.staff_name, 120);
        const gr = sname ? `Olá, ${sname}!` : "Olá!";
        const role = ROLE_LABEL[String(p.staff_role)] ?? "Equipe";
        const pass = typeof p.temp_password === "string" && p.temp_password.length >= 6 && p.temp_password.length <= 72 ? p.temp_password : "";
        const login = `${site}#/login`;
        const rows: [string, string][] = [["Endereço do painel", `${site}#/admin`], ["Usuário (e-mail)", to[0]], ["Senha provisória", pass || "informada pelo administrador"], ["Perfil de acesso", role]];
        mails.push({
          to,
          subject: "Bem-vindo(a) à Central de Solicitações Conceive: seus dados de acesso",
          html: layout({
            preheader: "Seu acesso ao painel da equipe foi criado.", eyebrow: "Boas-vindas", heading: "Seu acesso ao painel da equipe está pronto",
            body: para(esc(gr)) + para(`Seu acesso à <strong>Central de Solicitações Conceive</strong> foi criado com o perfil <strong>${esc(role)}</strong>. ${esc(ROLE_DESC[String(p.staff_role)] ?? "")}`)
              + details(rows)
              + `<p style="margin:0 0 6px;font-weight:700">Como acessar</p><ol style="margin:0 0 14px;padding-left:20px;line-height:1.7"><li>Clique em “Acessar o painel” e entre com o e-mail e a senha acima.</li><li>Se for solicitado, configure a verificação em duas etapas com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou similar).</li><li>Troque a senha provisória por uma senha pessoal no primeiro acesso.</li></ol>`
              + note("<strong>Segurança:</strong> não compartilhe a senha, apague este e-mail após o primeiro acesso e nunca informe sua senha ou códigos de verificação a terceiros. Se você não esperava este convite, ignore esta mensagem e avise o administrador."),
            button: { url: login, text: "Acessar o painel" }, signature: true, audience: "team", replyable,
          }),
          text: `${gr}\n\nSeu acesso à Central de Solicitações Conceive foi criado com o perfil ${role}. ${ROLE_DESC[String(p.staff_role)] ?? ""}\n\n${detailsText(rows)}\n\nComo acessar:\n1. Abra ${login} e entre com o e-mail e a senha acima.\n2. Se for solicitado, configure a verificação em duas etapas com um aplicativo autenticador.\n3. Troque a senha provisória por uma senha pessoal no primeiro acesso.\n\nSegurança: não compartilhe a senha e apague este e-mail após o primeiro acesso. Se você não esperava este convite, ignore esta mensagem e avise o administrador.\n\nAtenciosamente,\nEquipe Conceive\nCentral de Solicitações\n`,
        });
      }
      break;
    }
    case "test": {
      if (validEmail(p.test_to)) {
        const prov = (env.MAIL_PROVIDER ?? "resend").trim().toLowerCase();
        const remetente = oneLine(env.MAIL_FROM ?? "", 200);
        const rows: [string, string][] = [["Provedor de envio", prov], ["Remetente", remetente], ["Site", site], ["Link do cliente (exemplo)", `${site}#/acompanhar/…`]];
        mails.push({
          to: [p.test_to.trim()],
          subject: "[Conceive] Teste de e-mail",
          html: teamLayout({
            preheader: "O envio automático de e-mails está funcionando.", eyebrow: "Diagnóstico", heading: "Teste de e-mail concluído",
            body: para("Se você está lendo esta mensagem, o envio automático de e-mails da Central de Solicitações está funcionando.") + details(rows)
              + para("Os e-mails enviados aos clientes seguem o formato do link de exemplo. Se o endereço do site estiver incorreto, corrija o Secret <strong>SITE_URL</strong>.")
              + note("Se esta mensagem chegou na caixa de spam, marque-a como “não é spam” para que os e-mails reais cheguem na caixa de entrada."),
            button: { url: `${site}#/admin`, text: "Abrir o painel" },
          }),
          text: `Se você está lendo esta mensagem, o envio automático de e-mails da Central de Solicitações está funcionando.\n\n${detailsText(rows)}\n\nSe ela chegou na caixa de spam, marque como “não é spam”.\nPainel: ${site}#/admin\n`,
        });
      }
      break;
    }
    case "sla_digest": {
      if (team.length) {
        const items = (Array.isArray(p.items) ? p.items : []).slice(0, 30);
        const total = Number.isFinite(Number(p.count)) ? Number(p.count) : items.length;
        const why = (s: unknown) => (s === "PARADA" ? "parada" : "sem resposta");
        const lis = items.map((i: any) => `<li style="margin-bottom:6px"><strong>${esc(oneLine(i.protocol, 40))}</strong>: ${esc(oneLine(i.title, 120))} <span style="color:${C.muted}">(${why(i.sla)} há ${esc(String(Number(i.days) || 0))} dias)</span></li>`).join("");
        const txt = items.map((i: any) => `- ${oneLine(i.protocol, 40)}: ${oneLine(i.title, 120)} (${why(i.sla)} há ${Number(i.days) || 0} dias)`).join("\n");
        mails.push({
          to: team,
          subject: `[Conceive] ${total} ${total === 1 ? "solicitação precisa" : "solicitações precisam"} de atenção`,
          html: teamLayout({
            preheader: `${title}.`, eyebrow: "Resumo diário", heading: "Solicitações que precisam de atenção",
            body: para(`${esc(title)}.`) + `<ul style="margin:0 0 14px;padding-left:20px">${lis}</ul>` + (total > items.length ? para(`…e mais ${total - items.length}. Veja a lista completa no painel (filtro “Paradas”).`) : ""),
            button: { url: `${site}#/admin`, text: "Abrir o painel" },
          }),
          text: `${title}.\n\n${txt}\n\nPainel: ${site}#/admin\n`,
        });
      }
      break;
    }
  }
  return mails;
}

const EVENTS = ["request_created", "request_resend", "status_changed", "staff_welcome", "sla_digest", "test"];

/** Mensagem curta de erro devolvida pelo provedor (sem a chave, caso ela venha repetida). */
async function providerMessage(r: { json?: () => Promise<any>; text?: () => Promise<string> }, secret: string): Promise<string> {
  let msg = "";
  try {
    if (r.json) {
      const j = await r.json();
      const m = j?.message ?? j?.error?.message ?? j?.error ?? j?.name ?? (typeof j === "string" ? j : "");
      msg = typeof m === "string" ? m : JSON.stringify(m ?? "");
    } else if (r.text) msg = await r.text();
  } catch { /* corpo ilegível */ }
  msg = oneLine(msg, 200);
  return secret ? msg.split(secret).join("***") : msg;
}

/** Dica em português para os erros mais comuns de cada provedor. */
function hintFor(provider: string, status: number, message: string): string {
  const m = message.toLowerCase();
  if (status === 0) return "a função não conseguiu falar com o provedor (rede)";
  if (status === 429) return "limite de envios do provedor atingido (por segundo ou por dia)";
  if (provider === "apps_script") {
    if (m.includes("unauthorized")) return "APPS_SCRIPT_SECRET diferente da propriedade SECRET do script do Google";
    if (m.includes("script_sem_secret")) return "o script do Google não tem a propriedade SECRET (Configurações do projeto → Propriedades do script)";
    if (m.includes("implantação") || m.includes("login")) return "a implantação do script precisa estar como “Executar como: Eu” e “Quem tem acesso: Qualquer pessoa”; depois de editar o código, publique uma nova versão";
    if (m.includes("too many times") || m.includes("quota") || m.includes("limit")) return "limite diário de envios do Gmail atingido (cerca de 100 destinatários por dia em conta comum)";
    if (status === 404 || status === 403) return "URL do script (APPS_SCRIPT_URL) incorreta, ou implantação sem acesso para “Qualquer pessoa”";
    return "veja a mensagem do script";
  }
  if (provider === "brevo") {
    if (m.includes("ip") && (m.includes("unrecognised") || m.includes("unrecognized") || m.includes("authori"))) return "o Brevo bloqueou o IP do Supabase: em Brevo → Security → Authorized IPs, desative o bloqueio de IPs desconhecidos";
    if (status === 401) return "chave do Brevo inválida/copiada incompleta, ou bloqueio de IPs ativo no Brevo (Security → Authorized IPs)";
    if (status === 403) return "conta do Brevo ainda não liberada para envio, ou chave sem permissão";
    if (m.includes("sender")) return "o remetente (MAIL_FROM) não está validado no Brevo (Senders, domains & dedicated IPs → Senders)";
  } else {
    if (status === 401 || status === 403) return "chave do Resend inválida, ou domínio do remetente (MAIL_FROM) não verificado no Resend";
    if (status === 422 || status === 400) return "dados recusados pelo Resend: confira se MAIL_FROM usa o domínio verificado";
  }
  return "veja a mensagem do provedor";
}

export async function handle(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const given = req.headers.get("x-webhook-secret") ?? "";
  if (!env.WEBHOOK_SECRET) return json(401, { error: "unauthorized", reason: "o Secret WEBHOOK_SECRET não está cadastrado na função" });
  if (!given || !safeEqual(given, env.WEBHOOK_SECRET)) return json(401, { error: "unauthorized", reason: "o segredo do banco (notify_secret) é diferente do WEBHOOK_SECRET da função" });

  let payload: any;
  try { payload = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  if (!payload || typeof payload !== "object" || !EVENTS.includes(payload.event)) return json(400, { error: "invalid_event" });
  if (typeof payload.protocol !== "string" || typeof payload.title !== "string") return json(400, { error: "invalid_payload" });

  const provider = (env.MAIL_PROVIDER ?? "resend").trim().toLowerCase();
  if (provider !== "resend" && provider !== "brevo" && provider !== "apps_script") return json(500, { error: "not_configured", missing: ["MAIL_PROVIDER (use resend, brevo ou apps_script)"] });
  const apiKey = provider === "brevo" ? env.BREVO_API_KEY : provider === "apps_script" ? env.APPS_SCRIPT_SECRET : env.RESEND_API_KEY;
  const from = parseFrom(env.MAIL_FROM);
  const missing: string[] = [];
  if (provider === "apps_script") {
    if (!env.APPS_SCRIPT_URL) missing.push("APPS_SCRIPT_URL");
    else if (!APPS_URL_RE.test(env.APPS_SCRIPT_URL.trim())) missing.push("APPS_SCRIPT_URL (deve ser https://script.google.com/macros/s/.../exec)");
    if (!apiKey) missing.push("APPS_SCRIPT_SECRET");
  } else {
    if (!apiKey) missing.push(provider === "brevo" ? "BREVO_API_KEY" : "RESEND_API_KEY");
    if (!from) missing.push(env.MAIL_FROM ? "MAIL_FROM (formato: Nome <email@dominio.com>)" : "MAIL_FROM");
  }
  if (!env.SITE_URL) missing.push("SITE_URL");
  else if (!normalizeSite(env.SITE_URL)) missing.push("SITE_URL (deve ser https://usuario.github.io/repositorio/, sem espaços)");
  if (missing.length || !apiKey) return json(500, { error: "not_configured", missing });

  const mails = buildMails(payload, env);
  if (payload.event === "test" && mails.length === 0) return json(400, { error: "invalid_test_recipient" });
  const replyTo = validEmail(env.REPLY_TO) ? env.REPLY_TO.trim() : undefined;
  const eventId = typeof payload.event_id === "string" && EVENT_ID_RE.test(payload.event_id) ? payload.event_id : null;
  let sent = 0;
  for (const [i, m] of mails.entries()) {
    let failure: { provider_status: number; provider_message: string } | null = null;
    try {
      let r;
      if (provider === "apps_script") {
        // O Apps Script não lê cabeçalhos: o segredo vai no corpo (HTTPS). Ele responde 200 com { ok } mesmo em erro.
        r = await fetchFn(env.APPS_SCRIPT_URL!.trim(), {
          method: "POST",
          headers: { "content-type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ secret: apiKey, to: m.to, subject: m.subject, html: m.html, text: m.text, name: from?.name ?? "Conceive", ...(replyTo ? { replyTo } : {}) }),
        });
        let j: any = null;
        try { j = await r.json?.(); } catch { j = null; }
        if (!j || j.ok !== true) {
          failure = { provider_status: r.status, provider_message: j ? oneLine(String(j.error ?? "erro desconhecido"), 200) : "resposta inesperada (a implantação do script precisa estar com acesso para “Qualquer pessoa”; login do Google na resposta)" };
          return json(502, { error: "mail_failed", sent, provider, ...failure, hint: hintFor(provider, failure.provider_status, failure.provider_message) });
        }
        sent++;
        continue;
      }
      if (provider === "brevo") {
        // Brevo não tem Idempotency-Key: uma nova tentativa do mesmo evento pode duplicar o e-mail.
        r = await fetchFn("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            sender: from, to: m.to.map((email) => ({ email })), subject: m.subject, htmlContent: m.html, textContent: m.text,
            ...(replyTo ? { replyTo: { email: replyTo } } : {}),
          }),
        });
      } else {
        const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
        // Mesmo evento reenviado (nova tentativa) não gera e-mail duplicado: o Resend ignora a repetição por 24 h.
        if (eventId) headers["idempotency-key"] = `conceive-${eventId}-${i}`;
        r = await fetchFn("https://api.resend.com/emails", {
          method: "POST",
          headers,
          body: JSON.stringify({ from: env.MAIL_FROM, to: m.to, subject: m.subject, html: m.html, text: m.text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });
      }
      if (!r.ok) failure = { provider_status: r.status, provider_message: await providerMessage(r, apiKey) };
    } catch {
      failure = { provider_status: 0, provider_message: "falha de rede ao chamar o provedor" };
    }
    if (failure) return json(502, { error: "mail_failed", sent, provider, ...failure, hint: hintFor(provider, failure.provider_status, failure.provider_message) });
    sent++;
  }
  if (payload.event === "test") {
    // Valida o SITE_URL de verdade: o endereço precisa abrir (os links dos e-mails partem dele).
    const site = normalizeSite(env.SITE_URL)!;
    let site_status = 0;
    try { site_status = (await fetchFn(site, { method: "GET", signal: AbortSignal.timeout(6000) })).status; } catch { site_status = 0; }
    return json(200, { sent, provider, site_url: site, sample_link: `${site}#/acompanhar/…`, site_status });
  }
  return json(200, { sent });
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req: Request) => handle(req, Deno.env.toObject(), fetch as unknown as FetchFn));
}
