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
// Eventos aceitos (JSON): request_created, request_resend (reenvio ao cliente, botão do painel), status_changed, comment_public, client_reply, sla_digest (resumo diário da equipe)
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

function baseLayout(heading: string, bodyHtml: string, button?: { url: string; text: string }, formal = false, replyable = false): string {
  const btn = button
    ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="background:#4c1d95;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${esc(button.text)}</a></p>
       <p style="color:#6b6880;font-size:13px">Se o botão não funcionar, copie este endereço no navegador:<br>${esc(button.url)}</p>`
    : "";
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f6f5fa;font-family:Arial,Helvetica,sans-serif;color:#1d1b26">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="font-weight:700;color:#4c1d95;font-size:18px;margin:0 0 16px">Conceive · Central de Solicitações</p>
<div style="background:#ffffff;border:1px solid #e3e0ee;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
${bodyHtml}${btn}
</div>
${formal ? `<p style="margin:16px 0 0;font-size:14px">Atenciosamente,<br><strong>Equipe Conceive</strong></p>` : ""}
<p style="color:#6b6880;font-size:12px;margin-top:16px">${replyable ? "Dúvidas? Basta responder este e-mail." : "Esta é uma mensagem automática; não é necessário respondê-la."} Você a recebeu porque este endereço de e-mail foi informado em uma solicitação registrada na Conceive. Os dados pessoais são tratados em conformidade com a Lei Geral de Proteção de Dados (LGPD).</p>
</div></body></html>`;
}

/** Data e hora no fuso de Fortaleza, em português (ex.: 25/11/2026 às 00:25). */
function fmtDateTime(v: unknown): string {
  const d = new Date(String(v ?? ""));
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} às ${g("hour")}:${g("minute")}`;
}

const row = (k: string, v: string) => `<tr><td style="padding:4px 12px 4px 0;color:#6b6880">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`;

function buildMails(p: any, env: Env): Mail[] {
  const site = normalizeSite(env.SITE_URL) ?? "";
  const link = typeof p.tracking_token === "string" && TOKEN_RE.test(p.tracking_token) ? `${site}#/acompanhar/${p.tracking_token}` : null;
  const client = validEmail(p.client_email) && link ? [p.client_email.trim()] : [];
  const team = (env.TEAM_EMAILS ?? "").split(",").map((s) => s.trim()).filter(validEmail).slice(0, 50);
  const proto = oneLine(p.protocol, 40);
  const title = oneLine(p.title, 140);
  const mails: Mail[] = [];
  const replyable = validEmail(env.REPLY_TO);
  const layout = (h: string, b: string, btn?: { url: string; text: string }, formal = false) => baseLayout(h, b, btn, formal, replyable);
  const panel = adminLink(site, p.request_id);

  /** E-mail formal ao cliente com protocolo, resumo e o link pessoal. `resend` = reenvio pedido pela equipe (mostra a etapa atual). */
  const confirmation = (resend: boolean): Mail => {
    const nome = oneLine(p.requester_name, 120);
    const greet = nome ? `Prezado(a) ${nome},` : "Prezado(a) cliente,";
    const mod0 = label(MODULES, p.module), typ0 = label(TYPES, p.type), clin0 = oneLine(p.clinic_name || "—", 160);
    const when = fmtDateTime(p.created_at);
    const situacao = resend ? label(STATUSES, p.status) : "Recebido";
    const intro = resend
      ? `A pedido da nossa equipe, reenviamos as informações da sua solicitação, registrada sob o protocolo <strong style="font-size:18px">${esc(proto)}</strong>.`
      : `Confirmamos o recebimento da sua solicitação, registrada sob o protocolo <strong style="font-size:18px">${esc(proto)}</strong>. Nossa equipe fará a análise e retornará por este canal.`;
    const introTxt = resend
      ? `A pedido da nossa equipe, reenviamos as informações da sua solicitação, registrada sob o protocolo ${proto}.`
      : `Confirmamos o recebimento da sua solicitação, registrada sob o protocolo ${proto}.\nNossa equipe fará a análise e retornará por este canal.`;
    return {
      to: client,
      subject: resend ? `[${proto}] Reenvio: link de acompanhamento da sua solicitação` : `[${proto}] Confirmação de recebimento da sua solicitação`,
      html: layout(resend ? "Informações da sua solicitação" : "Confirmação de recebimento",
        `<p>${esc(greet)}</p>
         <p>${intro}</p>
         <table style="border-collapse:collapse;margin:12px 0">${row("Protocolo", proto)}${row("Assunto", title)}${row("Clínica", clin0)}${row("Módulo", mod0)}${row("Tipo de demanda", typ0)}${when ? row("Registrada em", when) : ""}${row("Situação atual", situacao)}</table>
         <p>Para consultar o andamento, enviar informações complementares ou avaliar o atendimento, utilize o botão abaixo.</p>
         <p><strong>Guarde este e-mail:</strong> o link é pessoal e é a única forma de acompanhar a solicitação, pois não há login para clientes. Não o compartilhe com terceiros.</p>`,
        { url: link!, text: "Acompanhar solicitação" }, true),
      text: `${greet}\n\n${introTxt}\n\nAssunto: ${title}\nClínica: ${clin0}\nMódulo: ${mod0}\nTipo de demanda: ${typ0}\n${when ? `Registrada em: ${when}\n` : ""}Situação atual: ${situacao}\n\nGuarde este e-mail: o link abaixo é pessoal e é a única forma de acompanhar a solicitação. Não o compartilhe com terceiros.\n${link}\n\nAtenciosamente,\nEquipe Conceive\n`,
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
        const mod = label(MODULES, p.module), typ = label(TYPES, p.type), clin = oneLine(p.clinic_name || "—", 160);
        mails.push({
          to: team,
          subject: `[${proto}] Nova solicitação: ${title}`,
          html: layout("Nova solicitação recebida",
            `<table style="border-collapse:collapse">${row("Protocolo", proto)}${row("Título", title)}${row("Módulo", mod)}${row("Tipo", typ)}${row("Clínica", clin)}</table>`,
            { url: panel, text: "Abrir no painel" }),
          text: `Nova solicitação recebida.\nProtocolo: ${proto}\nTítulo: ${title}\nMódulo: ${mod}\nTipo: ${typ}\nClínica: ${clin}\n\nAbrir no painel: ${panel}\n`,
        });
      }
      break;
    }
    case "status_changed": {
      if (client.length && link) {
        const st = label(STATUSES, p.status), prev = label(STATUSES, p.previous_status);
        if (p.status === "CONCLUIDO") {
          // Concluída: além de avisar, pede a avaliação (1 a 5), que fica na própria página de acompanhamento.
          mails.push({
            to: client,
            subject: `[${proto}] Solicitação concluída: conte como foi o atendimento`,
            html: layout("Sua solicitação foi concluída",
              `<p>${esc(title)}</p><table style="border-collapse:collapse">${row("Protocolo", proto)}${row("Etapa anterior", prev)}${row("Etapa atual", st)}</table>
               <p>Sua opinião nos ajuda a melhorar. Leva menos de um minuto: abra a página de acompanhamento e dê uma nota de 1 a 5 estrelas.</p>`,
              { url: link, text: "Avaliar o atendimento" }),
            text: `Sua solicitação ${proto} foi concluída.\n${title}\n\nSua opinião nos ajuda a melhorar. Abra a página de acompanhamento e dê uma nota de 1 a 5 estrelas:\n${link}\n`,
          });
        } else {
          mails.push({
            to: client,
            subject: `[${proto}] Sua solicitação mudou de etapa: ${st}`,
            html: layout("Sua solicitação mudou de etapa",
              `<p>${esc(title)}</p><table style="border-collapse:collapse">${row("Protocolo", proto)}${row("Etapa anterior", prev)}${row("Etapa atual", st)}</table>`,
              { url: link, text: "Acompanhar solicitação" }),
            text: `Sua solicitação ${proto} mudou de etapa.\n${title}\nDe: ${prev}\nPara: ${st}\n\nAcompanhe: ${link}\n`,
          });
        }
      }
      break;
    }
    case "comment_public": {
      if (client.length && link) {
        const body = String(p.body ?? "").slice(0, 4000);
        mails.push({
          to: client,
          subject: `[${proto}] Nova resposta da equipe`,
          html: layout("Nova resposta da equipe",
            `<p>${esc(title)}</p><blockquote style="margin:12px 0;padding:8px 14px;border-left:4px solid #6d28d9;background:#f6f5fa;white-space:pre-wrap">${esc(body)}</blockquote>`,
            { url: link, text: "Ver a solicitação" }),
          text: `Nova resposta da equipe na solicitação ${proto}.\n${title}\n\n${body}\n\nAcompanhe: ${link}\n`,
        });
      }
      break;
    }
    case "client_reply": {
      if (team.length) {
        const body = String(p.body ?? "").slice(0, 4000);
        mails.push({
          to: team,
          subject: `[${proto}] O cliente respondeu`,
          html: layout("O cliente respondeu",
            `<p>${esc(title)}</p><blockquote style="margin:12px 0;padding:8px 14px;border-left:4px solid #6d28d9;background:#f6f5fa;white-space:pre-wrap">${esc(body)}</blockquote>`,
            { url: panel, text: "Abrir no painel" }),
          text: `O cliente respondeu na solicitação ${proto}.\n${title}\n\n${body}\n\nAbrir no painel: ${panel}\n`,
        });
      }
      break;
    }
    case "test": {
      if (validEmail(p.test_to)) {
        const prov = (env.MAIL_PROVIDER ?? "resend").trim().toLowerCase();
        const remetente = oneLine(env.MAIL_FROM ?? "", 200);
        mails.push({
          to: [p.test_to.trim()],
          subject: "[Conceive] Teste de e-mail",
          html: layout("Teste de e-mail",
            `<p>Se você está lendo esta mensagem, o envio automático de e-mails do Conceive está funcionando.</p>
             <table style="border-collapse:collapse">${row("Provedor", prov)}${row("Remetente", remetente)}${row("Site", site)}${row("Link do cliente (exemplo)", `${site}#/acompanhar/…`)}</table>
             <p>Os e-mails aos clientes levam um link no formato do exemplo acima. Se o endereço do site estiver errado, corrija o Secret SITE_URL.</p>
             <p>Se ela chegou na caixa de spam, marque como “não é spam” para que os e-mails reais cheguem na caixa de entrada.</p>`,
            { url: `${site}#/admin`, text: "Abrir o painel" }),
          text: `Se você está lendo esta mensagem, o envio automático de e-mails do Conceive está funcionando.\nProvedor: ${prov}\nRemetente: ${remetente}\nSite: ${site}\nLink do cliente (exemplo): ${site}#/acompanhar/…\n\nSe ela chegou no spam, marque como “não é spam”.\nPainel: ${site}#/admin\n`,
        });
      }
      break;
    }
    case "sla_digest": {
      if (team.length) {
        const items = (Array.isArray(p.items) ? p.items : []).slice(0, 30);
        const total = Number.isFinite(Number(p.count)) ? Number(p.count) : items.length;
        const why = (s: unknown) => (s === "PARADA" ? "parada" : "sem resposta");
        const lis = items.map((i: any) => `<li><strong>${esc(oneLine(i.protocol, 40))}</strong> — ${esc(oneLine(i.title, 120))} <span style="color:#6b6880">(${why(i.sla)}, ${esc(String(Number(i.days) || 0))} dias)</span></li>`).join("");
        const txt = items.map((i: any) => `- ${oneLine(i.protocol, 40)}: ${oneLine(i.title, 120)} (${why(i.sla)}, ${Number(i.days) || 0} dias)`).join("\n");
        mails.push({
          to: team,
          subject: `[Conceive] ${total} ${total === 1 ? "solicitação precisa" : "solicitações precisam"} de atenção`,
          html: layout("Solicitações que precisam de atenção",
            `<p>${esc(title)}.</p><ul style="padding-left:18px">${lis}</ul>${total > items.length ? `<p>…e mais ${total - items.length}. Veja a lista completa no painel (filtro “Paradas”).</p>` : ""}`,
            { url: `${site}#/admin`, text: "Abrir o painel" }),
          text: `${title}.\n\n${txt}\n\nPainel: ${site}#/admin\n`,
        });
      }
      break;
    }
  }
  return mails;
}

const EVENTS = ["request_created", "request_resend", "status_changed", "comment_public", "client_reply", "sla_digest", "test"];

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
