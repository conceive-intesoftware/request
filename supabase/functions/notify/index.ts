// Edge Function "notify" — envia e-mails do Conceive pelo Resend.
// Chamada SOMENTE pelo banco (pg_net), com o cabeçalho x-webhook-secret. Cole este arquivo inteiro no
// editor de Edge Functions do Supabase (nome da função: notify) e DESLIGUE "Verify JWT" nela.
//
// Segredos (Edge Functions → Secrets):
//   WEBHOOK_SECRET   texto longo e aleatório (o mesmo guardado no banco)
//   RESEND_API_KEY   chave da API do Resend (re_...)
//   MAIL_FROM        ex.: Conceive <solicitacoes@seudominio.com.br>  (domínio verificado no Resend)
//   SITE_URL         endereço do site, ex.: https://usuario.github.io/conceive-requests/
//   TEAM_EMAILS      (opcional) e-mails da equipe, separados por vírgula
//
// Eventos aceitos (JSON): request_created, status_changed, comment_public, client_reply, sla_digest (resumo diário da equipe).

declare const Deno: any;

type Env = Record<string, string | undefined>;
type FetchFn = (input: string, init?: any) => Promise<{ ok: boolean; status: number; json?: () => Promise<any> }>;

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

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Mail { to: string[]; subject: string; html: string; text: string }

function layout(heading: string, bodyHtml: string, button?: { url: string; text: string }, formal = false): string {
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
<p style="color:#6b6880;font-size:12px;margin-top:16px">Esta é uma mensagem automática; não é necessário respondê-la. Você a recebeu porque este endereço de e-mail foi informado em uma solicitação registrada na Conceive. Os dados pessoais são tratados em conformidade com a Lei Geral de Proteção de Dados (LGPD).</p>
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
  const site = (env.SITE_URL ?? "").replace(/\/*$/, "/");
  const link = typeof p.tracking_token === "string" && TOKEN_RE.test(p.tracking_token) ? `${site}#/acompanhar/${p.tracking_token}` : null;
  const client = validEmail(p.client_email) && link ? [p.client_email.trim()] : [];
  const team = (env.TEAM_EMAILS ?? "").split(",").map((s) => s.trim()).filter(validEmail).slice(0, 50);
  const proto = oneLine(p.protocol, 40);
  const title = oneLine(p.title, 140);
  const mails: Mail[] = [];

  switch (p.event) {
    case "request_created": {
      if (client.length && link) {
        const nome = oneLine(p.requester_name, 120);
        const greet = nome ? `Prezado(a) ${nome},` : "Prezado(a) cliente,";
        const mod0 = label(MODULES, p.module), typ0 = label(TYPES, p.type), clin0 = oneLine(p.clinic_name || "—", 160);
        const when = fmtDateTime(p.created_at);
        mails.push({
          to: client,
          subject: `[${proto}] Confirmação de recebimento da sua solicitação`,
          html: layout("Confirmação de recebimento",
            `<p>${esc(greet)}</p>
             <p>Confirmamos o recebimento da sua solicitação, registrada sob o protocolo <strong style="font-size:18px">${esc(proto)}</strong>. Nossa equipe fará a análise e retornará por este canal.</p>
             <table style="border-collapse:collapse;margin:12px 0">${row("Protocolo", proto)}${row("Assunto", title)}${row("Clínica", clin0)}${row("Módulo", mod0)}${row("Tipo de demanda", typ0)}${when ? row("Registrada em", when) : ""}${row("Situação atual", "Recebido")}</table>
             <p>Para consultar o andamento, enviar informações complementares ou avaliar o atendimento, utilize o botão abaixo.</p>
             <p><strong>Guarde este e-mail:</strong> o link é pessoal e é a única forma de acompanhar a solicitação, pois não há login para clientes. Não o compartilhe com terceiros.</p>`,
            { url: link, text: "Acompanhar solicitação" }, true),
          text: `${greet}\n\nConfirmamos o recebimento da sua solicitação, registrada sob o protocolo ${proto}.\nNossa equipe fará a análise e retornará por este canal.\n\nAssunto: ${title}\nClínica: ${clin0}\nMódulo: ${mod0}\nTipo de demanda: ${typ0}\n${when ? `Registrada em: ${when}\n` : ""}Situação atual: Recebido\n\nGuarde este e-mail: o link abaixo é pessoal e é a única forma de acompanhar a solicitação. Não o compartilhe com terceiros.\n${link}\n\nAtenciosamente,\nEquipe Conceive\n`,
        });
      }
      if (team.length) {
        const mod = label(MODULES, p.module), typ = label(TYPES, p.type), clin = oneLine(p.clinic_name || "—", 160);
        mails.push({
          to: team,
          subject: `[${proto}] Nova solicitação: ${title}`,
          html: layout("Nova solicitação recebida",
            `<table style="border-collapse:collapse">${row("Protocolo", proto)}${row("Título", title)}${row("Módulo", mod)}${row("Tipo", typ)}${row("Clínica", clin)}</table>`),
          text: `Nova solicitação recebida.\nProtocolo: ${proto}\nTítulo: ${title}\nMódulo: ${mod}\nTipo: ${typ}\nClínica: ${clin}\n`,
        });
      }
      break;
    }
    case "status_changed": {
      if (client.length && link) {
        const st = label(STATUSES, p.status), prev = label(STATUSES, p.previous_status);
        mails.push({
          to: client,
          subject: `[${proto}] Sua solicitação mudou de etapa: ${st}`,
          html: layout("Sua solicitação mudou de etapa",
            `<p>${esc(title)}</p><table style="border-collapse:collapse">${row("Protocolo", proto)}${row("Etapa anterior", prev)}${row("Etapa atual", st)}</table>`,
            { url: link, text: "Acompanhar solicitação" }),
          text: `Sua solicitação ${proto} mudou de etapa.\n${title}\nDe: ${prev}\nPara: ${st}\n\nAcompanhe: ${link}\n`,
        });
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
            `<p>${esc(title)}</p><blockquote style="margin:12px 0;padding:8px 14px;border-left:4px solid #6d28d9;background:#f6f5fa;white-space:pre-wrap">${esc(body)}</blockquote>`),
          text: `O cliente respondeu na solicitação ${proto}.\n${title}\n\n${body}\n`,
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

const EVENTS = ["request_created", "status_changed", "comment_public", "client_reply", "sla_digest"];

export async function handle(req: Request, env: Env, fetchFn: FetchFn): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const given = req.headers.get("x-webhook-secret") ?? "";
  if (!env.WEBHOOK_SECRET || !given || !safeEqual(given, env.WEBHOOK_SECRET)) return json(401, { error: "unauthorized" });

  let payload: any;
  try { payload = await req.json(); } catch { return json(400, { error: "invalid_json" }); }
  if (!payload || typeof payload !== "object" || !EVENTS.includes(payload.event)) return json(400, { error: "invalid_event" });
  if (typeof payload.protocol !== "string" || typeof payload.title !== "string") return json(400, { error: "invalid_payload" });

  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !env.SITE_URL) return json(500, { error: "not_configured" });

  const mails = buildMails(payload, env);
  let sent = 0;
  for (const m of mails) {
    let ok = false;
    try {
      const r = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: m.to, subject: m.subject, html: m.html, text: m.text }),
      });
      ok = r.ok;
    } catch { ok = false; }
    if (!ok) return json(502, { error: "mail_failed", sent });
    sent++;
  }
  return json(200, { sent });
}

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req: Request) => handle(req, Deno.env.toObject(), fetch as unknown as FetchFn));
}
