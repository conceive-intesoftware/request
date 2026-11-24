// Insere uma Content-Security-Policy (<meta>) no index.html compilado.
// O GitHub Pages não deixa configurar cabeçalhos HTTP; a <meta> é o que dá para fazer. Observação: a meta NÃO
// suporta as diretivas frame-ancestors, report-uri e sandbox (o navegador as ignora).
//
// Fonte das exigências do Cloudflare Turnstile (conferida em developers.cloudflare.com/turnstile/reference/content-security-policy):
//   script-src  https://challenges.cloudflare.com
//   frame-src   https://challenges.cloudflare.com
//   connect-src 'self'  (só no modo "pre-clearance"; aqui não é usado — mantemos o domínio da Cloudflare por precaução)
// A página não cita style-src; o widget roda dentro de um iframe, e o 'unsafe-inline' em style-src é por causa
// dos estilos em linha do React. Não foi possível testar contra o Turnstile real neste ambiente: se o formulário
// ficar bloqueado depois de publicar, defina a variável CSP_DESATIVADA=true no GitHub e publique de novo.
//
// Uso:  VITE_SUPABASE_URL=https://xxxx.supabase.co node scripts/apply-csp.mjs dist/index.html
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TURNSTILE = "https://challenges.cloudflare.com";

export function buildCsp({ supabaseUrl, extraConnect = [] }) {
  let u;
  try {
    u = new URL(supabaseUrl);
  } catch {
    throw new Error("VITE_SUPABASE_URL inválida (esperado algo como https://xxxx.supabase.co)");
  }
  if (u.protocol !== "https:") throw new Error("VITE_SUPABASE_URL precisa começar com https://");
  const https = u.origin;
  const wss = `wss://${u.host}`;
  return [
    "default-src 'self'",
    `script-src 'self' ${TURNSTILE}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${https}`,
    "media-src 'self' blob:",
    "font-src 'self'",
    ["connect-src 'self'", https, wss, TURNSTILE, ...extraConnect].join(" "),
    `frame-src ${TURNSTILE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;

export function injectCsp(html, csp) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" />`;
  if (META_RE.test(html)) return html.replace(META_RE, () => tag);
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (charset) return html.slice(0, charset.index + charset[0].length) + "\n    " + tag + html.slice(charset.index + charset[0].length);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + "\n    " + tag + html.slice(head.index + head[0].length);
  throw new Error("index.html sem <head>: não foi possível inserir a CSP");
}

/** Retorna 0 em sucesso, 1 em erro (mensagens vão para o console). */
export function run(file, env = process.env, log = console) {
  if (!file) { log.error("Uso: node scripts/apply-csp.mjs <caminho/index.html>"); return 1; }
  if (String(env.CSP_DESATIVADA ?? "").toLowerCase() === "true") {
    log.warn("⚠ CSP_DESATIVADA=true: a política de segurança de conteúdo NÃO foi aplicada.");
    return 0;
  }
  if (!env.VITE_SUPABASE_URL) {
    log.error("Falta a variável VITE_SUPABASE_URL: sem ela não dá para montar a CSP.");
    return 1;
  }
  try {
    const csp = buildCsp({ supabaseUrl: env.VITE_SUPABASE_URL });
    writeFileSync(file, injectCsp(readFileSync(file, "utf8"), csp));
    log.log("✓ CSP aplicada em " + file);
    return 0;
  } catch (e) {
    log.error("Erro ao aplicar a CSP: " + e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv[2]));
}
