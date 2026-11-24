// Teste de ponta a ponta: navegador real (Chromium) -> site compilado -> Postgres real com a migração aplicada.
//   PSQL_CMD="psql -h localhost -U postgres" npm run test:e2e      (usuário superuser; precisa de playwright + chromium)
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../fake-supabase";
import { MFA_CODE, PASSWORD, startBridge } from "./bridge";
// @ts-ignore módulo .mjs sem tipos
import { buildCsp } from "../../scripts/apply-csp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

// resolve pacotes do projeto; se faltarem, tenta /opt/npm-tools (ambiente de CI do autor)
const req = createRequire(import.meta.url);
const fallback = createRequire("/opt/npm-tools/node_modules/x.js");
const load = (name: string): any => {
  try { return req(name); } catch { return fallback(name); }
};

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(root, "dist-e2e");

// ───────── 1. compilar o site (mesmo código-fonte, cliente Supabase trocado pelo stub) ─────────
const esbuild = load("esbuild");
mkdirSync(OUT, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, "src/main.tsx")],
  bundle: true,
  outfile: resolve(OUT, "app.js"),
  format: "esm",
  jsx: "automatic",
  sourcemap: false,
  logLevel: "warning",
  nodePaths: ["/opt/npm-tools/node_modules"],
  alias: { "@supabase/supabase-js": resolve(root, "tests/e2e/stub-supabase.ts") },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": '"http://stub"',
    "import.meta.env.VITE_SUPABASE_ANON_KEY": '"stub"',
    "import.meta.env.VITE_TURNSTILE_SITE_KEY": '""',
    "process.env.NODE_ENV": '"development"',
  },
});
writeFileSync(resolve(OUT, "index.html"), `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${buildCsp({ supabaseUrl: "https://stub.supabase.co" })}"><title>${/<title>(.*?)<\/title>/.exec(read("index.html"))?.[1] ?? ""}</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`);
console.log("✓ site compilado com esbuild");

// ───────── 2. banco ─────────
const db = new Db(process.env.E2E_DB ?? "conceive_e2e");
db.recreate();
db.file(read("supabase/tests/mock_supabase.sql"));
db.file(read("supabase/migrations/20261121000000_init.sql"));
const U = { admin: "a0000000-0000-0000-0000-000000000001", po: "a0000000-0000-0000-0000-000000000002", dev: "a0000000-0000-0000-0000-000000000004" };
db.sql(`
  insert into auth.users (id, email) values ('${U.admin}','admin@x.com'), ('${U.po}','po@x.com'), ('${U.dev}','dev@x.com');
  insert into public.profiles (id, email, name, role) values
    ('${U.admin}','admin@x.com','Ana Admin','ADMIN'), ('${U.po}','po@x.com','Paulo PO','PO'), ('${U.dev}','dev@x.com','Davi Dev','DEV_VIEWER');
  insert into public.clinics (id, name) values ('c0000000-0000-0000-0000-000000000001', 'Kardiomov');
  insert into public.clinic_units (clinic_id, name) values ('c0000000-0000-0000-0000-000000000001', 'Unidade 1');
`);

const server = await startBridge(db, OUT, PORT);
const { chromium } = load("playwright");
const browser = await chromium.launch();

let n = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    n++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n`, e);
    await shot();
    await finish(1);
  }
}
let current: any = null;
async function shot() {
  try { if (current) await current.screenshot({ path: resolve(OUT, "falha.png"), fullPage: true }); console.error("screenshot: dist-e2e/falha.png"); } catch { /* ignore */ }
}
async function finish(code: number) {
  await browser.close();
  server.close();
  process.exit(code);
}

const jsErrors: string[] = [];
/** Com E2E_SHOTS=1, salva capturas de tela em dist-e2e/ (para revisar o visual). */
async function snap(page: any, name: string) {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
}
async function newPage(): Promise<any> {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e: Error) => jsErrors.push(e.message));
  page.on("console", (m: any) => m.type() === "error" && jsErrors.push(`console: ${m.text()}`));
  page.on("dialog", (d: any) => d.accept());
  current = page;
  return page;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const TITLE = "Pagamento antecipado de percentual de consulta";

async function login(page: any, email: string, opts: { firstTime: boolean; wrongCodeFirst?: boolean }) {
  await page.goto(`${BASE}/#/login`);
  await page.fill("#email", email);
  await page.fill("#pw", PASSWORD);
  await page.click("button:has-text('Entrar')");
  if (opts.firstTime) {
    await page.waitForSelector("text=Primeiro acesso");
    assert.ok(await page.isVisible("img.qr"), "QR code exibido");
    await page.fill("#code", MFA_CODE);
    await page.click("button:has-text('Confirmar e entrar')");
  } else {
    await page.waitForSelector("#code2");
    if (opts.wrongCodeFirst) {
      await page.fill("#code2", "000000");
      await page.click("button:has-text('Entrar')");
      await page.waitForSelector("text=Código inválido");
    }
    await page.fill("#code2", MFA_CODE);
    await page.click("button:has-text('Entrar')");
  }
  await page.waitForSelector("h1:has-text('Solicitações')");
}

(async () => {
  let tracking = "";
  let visitor: any, po: any;

  console.log("cliente final (navegador)");
  visitor = await newPage();
  await step("abre o formulário e a sessão anônima é criada sozinha", async () => {
    await visitor.goto(`${BASE}/#/solicitar`);
    await visitor.waitForSelector("h1:has-text('Solicitação de funcionalidade')");
    await visitor.waitForSelector("#clinic");
    assert.equal(await visitor.locator("button:has-text('Enviar solicitação')").isDisabled(), false);
  });
  await step("descrição: placeholder novo e dica de LGPD (sem o texto antigo)", async () => {
    assert.equal(await visitor.getAttribute("#desc", "placeholder"), "Escreva a sua solicitação aqui…");
    const html = await visitor.content();
    assert.ok(!html.includes("Qual problema quer resolver"), "texto antigo removido");
    assert.ok(html.includes("não inclua dados pessoais de pacientes (nome, CPF, prontuário)"));
  });
  await step("cabeçalho: abas sem barra de rolagem em 1045, 1280 e 390 px", async () => {
    for (const w of [1280, 1045, 390]) {
      await visitor.setViewportSize({ width: w, height: 800 });
      const m = await visitor.evaluate(() => {
        const el = document.querySelector(".site-tabs") as HTMLElement;
        const cs = getComputedStyle(el);
        return { v: el.scrollHeight > el.clientHeight + 1, sbw: el.offsetWidth - el.clientWidth, sbh: el.offsetHeight - el.clientHeight, ox: cs.overflowX, page: document.documentElement.scrollWidth > window.innerWidth };
      });
      assert.equal(m.v, false, `sem rolagem vertical (${w}px)`);
      assert.equal(m.sbw + m.sbh, 0, `sem barra visível (${w}px)`);
      assert.equal(m.page, false, `sem rolagem horizontal da página (${w}px)`);
      const same = await visitor.evaluate(() => {
        const t = document.querySelector(".theme-toggle")!.getBoundingClientRect(), b = document.querySelector(".site-brand")!.getBoundingClientRect(), tabs = document.querySelector(".site-tabs")!.getBoundingClientRect();
        return { toggleBesideBrand: Math.abs((t.top + t.height / 2) - (b.top + b.height / 2)) < 30, tabsHeight: tabs.height };
      });
      assert.equal(same.toggleBesideBrand, true, `botão de tema na mesma linha da marca (${w}px)`);
    }
    await visitor.setViewportSize({ width: 1280, height: 800 });
  });
  await step("envio vazio mostra erros de validação em cada campo", async () => {
    await visitor.click("button:has-text('Enviar solicitação')");
    for (const t of ["Revise os campos destacados.", "Selecione sua clínica", "Informe seu nome completo.", "Selecione seu cargo", "WhatsApp inválido", "Selecione o módulo", "Selecione o tipo", "Título muito curto", "Descreva com mais detalhes"]) {
      await visitor.waitForSelector(`text=${t}`);
    }
  });
  await step("autocomplete encontra a clínica (sem acento/caixa) e carrega as unidades", async () => {
    await visitor.fill("#clinic", "KARDIÓ");
    await visitor.click("[role=option]:has-text('Kardiomov')");
    await visitor.waitForSelector("#unit");
    await visitor.selectOption("#unit", { label: "Unidade 1" });
  });
  await step("máscara do WhatsApp e demais campos", async () => {
    await visitor.fill("#name", "Sarah Silva");
    await visitor.selectOption("#role", "ADMINISTRADOR");
    await visitor.fill("#wa", "84998493000");
    assert.equal(await visitor.inputValue("#wa"), "(84) 99849-3000");
    await visitor.selectOption("#module", "FINANCEIRO");
    await visitor.selectOption("#type", "MELHORIA_FLUXO");
    await visitor.fill("#title", TITLE);
    await visitor.fill("#desc", "Definimos que iremos solicitar aos nossos pacientes um percentual antecipado.");
    await snap(visitor, "01-formulario");
  });
  await step("anexos: tipo proibido é recusado, PNG é aceito", async () => {
    await visitor.setInputFiles("#files", { name: "virus.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") });
    await visitor.waitForSelector("text=tipo não permitido");
    await visitor.setInputFiles("#files", { name: "print da tela.png", mimeType: "image/png", buffer: PNG });
    await visitor.waitForSelector("li:has-text('print da tela.png')");
  });
  await step("anexos: arquivo acima de 50 MB é recusado", async () => {
    const big = resolve(OUT, "video-grande.mp4");
    writeFileSync(big, Buffer.alloc(51 * 1024 * 1024, 1));
    await visitor.setInputFiles("#files", big);
    await visitor.waitForSelector("text=passa de 50 MB");
    assert.equal(await visitor.locator("li:has-text('video-grande.mp4')").count(), 0);
  });
  await step("anexos: Ctrl+V cola um print (vira print-AAAAMMDD-HHMMSS.png, com miniatura)", async () => {
    await visitor.evaluate((b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG.toString("base64"));
    await visitor.waitForSelector("li:has-text('print-')");
    assert.match((await visitor.textContent("li:has-text('print-') .fname")) ?? "", /print-\d{8}-\d{6}\.png/);
    assert.equal(await visitor.locator("li:has-text('print-') img.thumb").count(), 1);
    await visitor.waitForSelector("text=Imagem colada.");
  });
  await step("Ctrl+V de TEXTO na descrição continua colando texto (não vira anexo)", async () => {
    const before = await visitor.locator(".files li").count();
    await visitor.focus("#desc");
    await visitor.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "texto colado");
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector("#desc")!.dispatchEvent(ev);
      (window as any).__prevented = ev.defaultPrevented;
    });
    assert.equal(await visitor.evaluate(() => (window as any).__prevented), false);
    assert.equal(await visitor.locator(".files li").count(), before);
  });
  await step("anexos: arrastar e soltar na área de anexos", async () => {
    const before = await visitor.locator(".files li").count();
    await visitor.evaluate((b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "arrastado.png", { type: "image/png" }));
      document.querySelector(".dropzone")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, PNG.toString("base64"));
    await visitor.waitForSelector("li:has-text('arrastado.png')");
    await visitor.click("li:has-text('arrastado.png') button:has-text('remover')");
    assert.equal(await visitor.locator(".files li").count(), before);
  });
  await step("envia e recebe o protocolo", async () => {
    await visitor.click("button:has-text('Enviar solicitação')");
    await visitor.waitForSelector("h2:has-text('Solicitação enviada!')");
    const proto = (await visitor.textContent(".protocol")) ?? "";
    assert.match(proto, /^CON-\d{4}-0001$/);
  });
  await step("acompanhamento: título e etapa atual 'Recebido'", async () => {
    await visitor.click("button:has-text('Acompanhar solicitação')");
    await visitor.waitForSelector(`h2:has-text('${TITLE}')`);
    const cur = await visitor.textContent("li[aria-current=step]");
    assert.match(cur ?? "", /Recebido/);
    tracking = (await visitor.url()).split("/acompanhar/")[1];
    assert.match(tracking, /^[0-9a-f]{48}$/);
    assert.ok(!(await visitor.content()).includes("Sarah"), "página pública não vaza nome");
    assert.ok(!(await visitor.content()).includes("99849"), "página pública não vaza telefone");
  });
  await step("link inválido mostra 'não encontrada'", async () => {
    await visitor.goto(`${BASE}/#/acompanhar/${"0".repeat(48)}`);
    await visitor.waitForSelector("h2:has-text('Solicitação não encontrada')");
  });
  await step("'minha clínica não está na lista' gera pedido com clínica pendente", async () => {
    await visitor.goto(`${BASE}/#/solicitar`);
    await visitor.waitForSelector("#clinic");
    await visitor.click("text=Minha clínica não está na lista");
    await visitor.fill("#pending", "Hospital de Olhos de Parnamirim");
    await visitor.fill("#name", "Renata");
    await visitor.selectOption("#role", "FARMACEUTICO");
    await visitor.fill("#wa", "84987417184");
    await visitor.selectOption("#module", "ESTOQUE_FARMACIA");
    await visitor.selectOption("#type", "NOVA_FUNCIONALIDADE");
    await visitor.fill("#title", "Adicionar Marcas");
    await visitor.fill("#desc", "Solicito adicionar na aba de adicionar um produto a opção de marca.");
    await visitor.click("button:has-text('Enviar solicitação')");
    await visitor.waitForSelector("h2:has-text('Solicitação enviada!')");
    assert.match((await visitor.textContent(".protocol")) ?? "", /-0002$/);
  });

  await step("abas: Solicitação / Acompanhar / Acesso da equipe", async () => {
    await visitor.goto(`${BASE}/#/solicitar`);
    await visitor.waitForSelector("a.site-tab.on:has-text('Solicitação de funcionalidade')");
    await visitor.click("a.site-tab:has-text('Acompanhar sua solicitação')");
    await visitor.waitForSelector("h1:has-text('Acompanhar sua solicitação')");
    await visitor.waitForSelector("a.site-tab.on:has-text('Acompanhar sua solicitação')");
    await visitor.fill("#track-link", "isso não é um link");
    await visitor.click("button:has-text('Acompanhar')");
    await visitor.waitForSelector("text=Link inválido");
    await visitor.fill("#track-link", `${BASE}/#/acompanhar/${tracking}`);
    await visitor.click("form button:has-text('Acompanhar')");
    await visitor.waitForSelector(`h2:has-text('${TITLE}')`);
    await visitor.waitForSelector("a.site-tab.on:has-text('Acompanhar sua solicitação')");
    await snap(visitor, "07-acompanhar");
    await visitor.click("a.site-tab:has-text('Acesso da equipe')");
    await visitor.waitForSelector("h1:has-text('Acesso da equipe')");
    await visitor.waitForSelector("a.site-tab.on:has-text('Acesso da equipe')");
    await visitor.click("a.site-tab:has-text('Solicitação de funcionalidade')");
    await visitor.waitForSelector("h1:has-text('Solicitação de funcionalidade')");
    assert.ok((await visitor.title()).includes("Conceive"));
    assert.ok(!(await visitor.content()).includes("ConceIve"));
  });

  console.log("equipe — PO");
  po = await newPage();
  await step("/admin sem login redireciona para o login", async () => {
    await po.goto(`${BASE}/#/admin`);
    await po.waitForSelector("h1:has-text('Acesso da equipe')");
    assert.match(po.url(), /#\/login/);
  });
  await step("login inválido mostra erro genérico", async () => {
    await po.fill("#email", "po@x.com");
    await po.fill("#pw", "errada");
    await po.click("button:has-text('Entrar')");
    await po.waitForSelector("text=E-mail, senha ou verificação inválidos.");
  });
  await step("1º acesso: cadastra o autenticador e entra no painel (sem voltar ao login)", async () => {
    await login(po, "po@x.com", { firstTime: true });
    assert.match(po.url(), /#\/admin$/);
    await po.waitForTimeout(400); // deixa os eventos de auth atrasados dispararem
    assert.match(po.url(), /#\/admin$/, "continua no painel depois dos eventos de auth");
  });
  await step("lista mostra dados pessoais ao PO; sem aba Equipe", async () => {
    await po.waitForSelector("td:has-text('Sarah Silva')");
    assert.ok(await po.isVisible(`td:has-text('${TITLE}')`));
    assert.ok(await po.isVisible("td:has-text('Hospital de Olhos de Parnamirim')"), "clínica pendente exibida");
    assert.equal(await po.locator("nav a:has-text('Equipe')").count(), 0);
    assert.equal(await po.locator("nav a:has-text('Clínicas')").count(), 0);
    await snap(po, "02-lista");
  });
  await step("filtro por texto e por status", async () => {
    await po.fill("input[aria-label=Buscar]", "Marcas");
    await po.click(".filters button:has-text('Buscar')");
    await po.waitForSelector("text=1 resultado(s)");
    assert.equal(await po.locator("td:has-text('Sarah Silva')").count(), 0);
    await po.click("button:has-text('Limpar')");
    await po.waitForSelector("text=2 resultado(s)");
    await po.selectOption("select[aria-label=Status]", "CONCLUIDO");
    await po.waitForSelector("text=Nenhuma solicitação encontrada.");
    await po.click("button:has-text('Limpar')");
    await po.waitForSelector("text=2 resultado(s)");
  });
  await step("modal: detalhes, anexo, mudar status", async () => {
    await po.click(`td:has-text('${TITLE}')`);
    await po.waitForSelector("[role=dialog] >> text=Definimos que iremos");
    assert.ok(await po.isVisible("[role=dialog] >> text=print_da_tela.png"), "anexo listado com nome saneado");
    assert.ok(await po.isVisible("[role=dialog] >> text=/print-\\d{8}-\\d{6}\\.png/"), "print colado chegou como anexo");
    await po.selectOption("#st", "EM_ANALISE_PRODUTO");
    await po.waitForFunction(() => (document.querySelector("#st") as HTMLSelectElement | null)?.value === "EM_ANALISE_PRODUTO");
  });
  await step("modal: abrir anexo gera URL assinada (popup)", async () => {
    await po.context().route("https://signed.example/**", (r: any) => r.fulfill({ status: 200, contentType: "text/plain", body: "ok" }));
    const [popup] = await Promise.all([po.waitForEvent("popup"), po.click("[role=dialog] button:has-text('abrir')")]);
    await popup.waitForLoadState();
    assert.match(popup.url(), /signed\.example\/attachments\//);
    await popup.close();
  });
  await step("modal: priorização RICE calcula ao vivo e salva", async () => {
    await po.click("[role=tab]:has-text('Priorização')");
    await po.selectOption("#pr", "ALTA");
    await po.fill("#re", "100");
    await po.selectOption("#im", "2");
    await po.fill("#co", "0.8");
    await po.fill("#ef", "4");
    await po.waitForSelector(".big:has-text('40')");
    await po.click("button:has-text('Salvar priorização')");
    await po.click("[role=tab]:has-text('Detalhes')");
    await po.waitForSelector("dd:has-text('Alta · 40')");
  });
  await step("modal: resposta pública (e interna) em Comentários", async () => {
    await po.click("[role=tab]:has-text('Comentários')");
    await po.fill("textarea[aria-label=Comentário]", "nota interna: cliente antigo");
    await po.click("button:has-text('Enviar')");
    await po.waitForSelector("li.internal:has-text('nota interna')");
    await po.fill("textarea[aria-label=Comentário]", "Olá! Seu pedido está em análise pela equipe de produto.");
    await po.check("label.check input[type=checkbox]");
    await po.click("button:has-text('Enviar')");
    await po.waitForSelector("li.public:has-text('em análise pela equipe')");
    assert.ok(await po.isVisible("a:has-text('Avisar cliente no WhatsApp')"));
    await snap(po, "03-modal-comentarios");
  });
  await step("modal: auditoria mostra antes/depois e a visualização de dado sensível", async () => {
    await po.click("[role=tab]:has-text('Auditoria')");
    await po.waitForSelector(".audit .a-VIEW_SENSITIVE");
    await po.waitForSelector(".audit .a-CREATE");
    const updates = po.locator(".audit-head:has(.a-UPDATE)");
    await updates.last().click();
    await po.waitForSelector(".diff td.mono:has-text('status')");
    assert.ok(await po.isVisible(".diff .old:has-text('RECEBIDO')"));
    assert.ok(await po.isVisible(".diff .new:has-text('EM_ANALISE_PRODUTO')"));
  });
  await step("cliente vê status novo e resposta pública (interna não aparece)", async () => {
    const v2 = await newPage();
    await v2.goto(`${BASE}/#/acompanhar/${tracking}`);
    await v2.waitForSelector("text=Seu pedido está em análise pela equipe");
    assert.match((await v2.textContent("li[aria-current=step]")) ?? "", /Em análise de produto/);
    assert.ok(!(await v2.content()).includes("cliente antigo"), "nota interna não vaza");
    current = po;
  });
  await step("mesclar: duplicata é ligada à principal pelo protocolo", async () => {
    await po.keyboard.press("Escape");
    await po.click("td:has-text('Adicionar Marcas')");
    await po.fill("input[aria-label='Protocolo para mesclar']", "CON-2026-0001".replace("2026", String(new Date().getFullYear())));
    await po.click("button:has-text('Mesclar nesta')");
    await po.waitForSelector("text=foi mesclada em");
    await po.keyboard.press("Escape");
    await po.waitForSelector("td:has-text('+1 similar(es)')");
  });
  await step("kanban: card na coluna certa e arrastar muda o status", async () => {
    await po.click(".seg button:has-text('Kanban')");
    await po.waitForSelector("section[aria-label='Em análise de produto'] .card-k");
    const card = po.locator(`section[aria-label='Em análise de produto'] .card-k:has-text('${TITLE}')`);
    await snap(po, "04-kanban");
    await card.dragTo(po.locator("section[aria-label='Aprovado para roadmap']"));
    await po.waitForSelector(`section[aria-label='Aprovado para roadmap'] .card-k:has-text('${TITLE}')`);
    const v3 = await newPage();
    await v3.goto(`${BASE}/#/acompanhar/${tracking}`);
    await v3.waitForSelector("li[aria-current=step]:has-text('Aprovado para roadmap')");
    current = po;
  });
  await step("exportar CSV: baixa arquivo sem dados pessoais", async () => {
    await po.click(".seg button:has-text('Lista')");
    const [dl] = await Promise.all([po.waitForEvent("download"), po.click("button:has-text('Exportar CSV')")]);
    const text = readFileSync(await dl.path(), "utf8");
    assert.ok(text.includes('"Protocolo","Título","Clínica"'));
    assert.ok(text.includes("Pagamento antecipado"));
    assert.ok(!text.includes("Sarah") && !text.includes("+55"));
  });
  await step("sair e entrar de novo: pede só o código (código errado é recusado)", async () => {
    await po.click("button:has-text('Sair')");
    await po.waitForSelector("h1:has-text('Acesso da equipe')");
    await login(po, "po@x.com", { firstTime: false, wrongCodeFirst: true });
  });
  await step("arquivar some da lista", async () => {
    await po.click("td:has-text('Adicionar Marcas')");
    await po.click("button:has-text('Arquivar')");
    await po.waitForSelector("text=1 resultado(s)");
  });

  console.log("equipe — Dev");
  const dev = await newPage();
  await step("dev vê dados mascarados, sem exportar, sem auditoria, status bloqueado", async () => {
    await login(dev, "dev@x.com", { firstTime: true });
    await dev.waitForSelector("td:has-text('S**** S****')");
    assert.equal(await dev.locator("td:has-text('Sarah Silva')").count(), 0);
    assert.equal(await dev.locator("button:has-text('Exportar CSV')").count(), 0);
    await dev.click(`td:has-text('${TITLE}')`);
    await dev.waitForSelector("[role=dialog] >> text=mascarado (LGPD)");
    assert.equal(await dev.locator("[role=tab]:has-text('Auditoria')").count(), 0);
    assert.equal(await dev.locator("#st").isDisabled(), true);
    assert.ok(await dev.isVisible("dd:has-text('(**) *****-3000')"));
  });
  await step("dev só comenta internamente (checkbox de resposta pública desabilitado)", async () => {
    await dev.click("[role=tab]:has-text('Comentários')");
    assert.equal(await dev.locator("label.check input[type=checkbox]").isDisabled(), true);
  });

  console.log("equipe — Admin");
  const admin = await newPage();
  await step("admin gerencia clínicas e unidades", async () => {
    await login(admin, "admin@x.com", { firstTime: true });
    await admin.click("nav a:has-text('Clínicas')");
    await admin.waitForSelector("h1:has-text('Clínicas e unidades')");
    await admin.fill("input[aria-label='Nome da clínica']", "Med Clínica Goianinha");
    await admin.click("button:has-text('Adicionar clínica')");
    await admin.waitForSelector("h2:has-text('Med Clínica Goianinha')");
    await admin.fill("input[aria-label='Nova unidade de Med Clínica Goianinha']", "Matriz");
    await admin.click("section:has(h2:has-text('Med Clínica Goianinha')) button:has-text('Adicionar unidade')");
    await admin.waitForSelector("section:has(h2:has-text('Med Clínica Goianinha')) .tag:has-text('Matriz')");
    await admin.fill("input[aria-label='Nome da clínica']", "med clínica goianinha");
    await admin.click("button:has-text('Adicionar clínica')");
    await admin.waitForSelector("text=Já existe um registro com esse nome.");
  });
  await step("admin vê a equipe e não consegue rebaixar o último admin", async () => {
    await admin.click("nav a:has-text('Equipe')");
    await admin.waitForSelector("td:has-text('Davi Dev')");
    await admin.selectOption("select[aria-label='Papel de Ana Admin']", "PO");
    await admin.waitForSelector("text=Não é possível rebaixar/desativar o último administrador.");
  });
  await step("equipe: seção 'E-mails automáticos' aparece para o Admin (vazia sem configuração)", async () => {
    await admin.waitForSelector("h2:has-text('E-mails automáticos')");
    await admin.waitForSelector("text=Nenhum envio registrado.");
  });
  await step("clínica nova já aparece no autocomplete do formulário público", async () => {
    const v4 = await newPage();
    await v4.goto(`${BASE}/#/solicitar`);
    await v4.waitForSelector("#clinic");
    await v4.fill("#clinic", "goianinha");
    await v4.waitForSelector("[role=option]:has-text('Med Clínica Goianinha')");
  });


  console.log("v2 — rascunho, roadmap, respostas, CSAT, métricas, importação, tema");
  await step("rascunho: o que foi digitado volta depois de recarregar a página; descartar limpa", async () => {
    const d1 = await newPage();
    await d1.goto(`${BASE}/#/solicitar`);
    await d1.waitForSelector("#clinic");
    await d1.fill("#name", "Rafaela Rascunho");
    await d1.fill("#email", "rafa@exemplo.com");
    await d1.fill("#desc", "Texto que ainda não foi enviado");
    await d1.waitForSelector("text=Rascunho salvo automaticamente");
    await d1.reload();
    await d1.waitForSelector("text=Recuperamos o rascunho");
    assert.equal(await d1.inputValue("#name"), "Rafaela Rascunho");
    assert.equal(await d1.inputValue("#email"), "rafa@exemplo.com");
    assert.equal(await d1.inputValue("#desc"), "Texto que ainda não foi enviado");
    await d1.click("button:has-text('Descartar rascunho')");
    assert.equal(await d1.inputValue("#name"), "");
    await d1.reload();
    await d1.waitForSelector("#clinic");
    assert.equal(await d1.locator("text=Recuperamos o rascunho").count(), 0);
  });
  await step("e-mail inválido é recusado no formulário", async () => {
    const d2 = await newPage();
    await d2.goto(`${BASE}/#/solicitar`);
    await d2.waitForSelector("#clinic");
    await d2.fill("#email", "isso-nao-e-email");
    await d2.click("button:has-text('Enviar solicitação')");
    await d2.waitForSelector("#email ~ .error, .error:has-text('e-mail')");
  });

  const po2 = await newPage();
  await step("PO publica a solicitação no roadmap (com aviso de privacidade)", async () => {
    await login(po2, "po@x.com", { firstTime: true });
    await po2.click(`td:has-text('${TITLE}')`);
    await po2.waitForSelector("[role=dialog] >> text=Mostrar no roadmap público");
    await po2.click("[role=dialog] label:has-text('Mostrar no roadmap público') input");
    await po2.waitForFunction(() => Array.from(document.querySelectorAll("[role=dialog] label.check")).some((l) => /roadmap/.test(l.textContent ?? "") && (l.querySelector("input") as HTMLInputElement).checked));
    await po2.keyboard.press("Escape");
    await po2.waitForSelector(`tr:has-text('${TITLE}') >> text=público`);
  });
  const voter = await newPage();
  await step("roadmap: outra pessoa vê só título/descrição, apoia e remove o apoio", async () => {
    await voter.goto(`${BASE}/#/comunidade`);
    await voter.waitForSelector(`h2:has-text('${TITLE}')`);
    const html = await voter.content();
    assert.ok(!html.includes("Sarah") && !html.includes("99849"), "roadmap não vaza dados pessoais");
    await voter.click("button:has-text('Também preciso disso')");
    await voter.waitForSelector("button[aria-pressed=true]");
    await voter.waitForSelector("p.votes[aria-label='1 apoio']");
    await voter.reload();
    await voter.waitForSelector("button[aria-pressed=true]");
    await voter.click("button[aria-pressed=true]");
    await voter.waitForSelector("button[aria-pressed=false]");
    await voter.click("button[aria-pressed=false]");
    await voter.waitForSelector("p.votes[aria-label='1 apoio']");
    await snap(voter, "04-roadmap");
  });
  await step("o autor não consegue apoiar a própria solicitação", async () => {
    await visitor.goto(`${BASE}/#/comunidade`);
    await visitor.waitForSelector(`h2:has-text('${TITLE}')`);
    await visitor.waitForSelector("text=Seu pedido");
    assert.equal(await visitor.locator("button:has-text('Também preciso disso')").count(), 0, "autor não tem botão de apoio");
  });
  await step("cliente responde na página de acompanhamento e a equipe vê 'Cliente' + 'aguardando resposta'", async () => {
    await visitor.goto(`${BASE}/#/acompanhar/${tracking}`);
    await visitor.waitForSelector("#reply");
    await visitor.fill("#reply", "Segue mais um detalhe: o caso acontece só na unidade 2.");
    await visitor.click("button:has-text('Enviar resposta')");
    await visitor.waitForSelector("text=unidade 2");
    await po2.reload();
    await po2.waitForSelector(`tr:has-text('${TITLE}') >> text=aguardando resposta`);
    await po2.click(`td:has-text('${TITLE}')`);
    await po2.click("[role=dialog] [role=tab]:has-text('Comentários')");
    await po2.waitForSelector("li.public:has-text('unidade 2') .from-client");
    await po2.keyboard.press("Escape");
  });
  await step("criar tarefa no Redmine grava o vínculo externo", async () => {
    await po2.click(`td:has-text('${TITLE}')`);
    await po2.click("[role=dialog] button:has-text('Criar tarefa no Redmine')");
    await po2.waitForFunction(() => (document.querySelector("[role=dialog] input[aria-label='ID externo']") as HTMLInputElement | null)?.value === "4321");
    assert.equal(await po2.locator("[role=dialog] button:has-text('Criar tarefa no')").count(), 0, "botões somem depois do vínculo");
    await po2.keyboard.press("Escape");
  });
  await step("CSAT: ao concluir, o cliente avalia com estrelas e a equipe vê a nota", async () => {
    await po2.click(`td:has-text('${TITLE}')`);
    await po2.selectOption("#st", "CONCLUIDO");
    await po2.waitForFunction(() => (document.querySelector("#st") as HTMLSelectElement | null)?.value === "CONCLUIDO");
    await po2.keyboard.press("Escape");
    await visitor.goto(`${BASE}/#/acompanhar/${tracking}`);
    await visitor.reload();
    await visitor.waitForSelector("h2:has-text('Como foi o atendimento?')");
    await visitor.click("button[aria-label='4 estrelas']");
    await visitor.fill("textarea[aria-label='Comentário da avaliação']", "Atendimento rápido");
    await visitor.click("button:has-text('Enviar avaliação')");
    await visitor.waitForSelector("text=Alterar avaliação");
    await po2.reload();
    await po2.waitForSelector(`tr:has-text('${TITLE}') >> text=★ 4`);
    await po2.click(`td:has-text('${TITLE}')`);
    await po2.waitForSelector("[role=dialog] >> text=Atendimento rápido");
    await po2.keyboard.press("Escape");
  });
  await step("métricas: KPIs, gráficos e período", async () => {
    await po2.click("nav a:has-text('Métricas')");
    await po2.waitForSelector("h1:has-text('Métricas')");
    await po2.waitForSelector(".kpi:has-text('Satisfação') strong:has-text('4')");
    await po2.waitForSelector(".kpi:has-text('Concluídas') strong:has-text('1')");
    assert.ok(await po2.isVisible("[aria-label='Solicitações por semana'], [role=img][aria-label^='Solicitações por semana']"));
    await po2.selectOption("#period", "30");
    await po2.waitForSelector(".kpis");
    assert.equal(await po2.locator("nav a:has-text('Importar')").count(), 0, "PO não importa");
    await snap(po2, "05-metricas");
  });
  current = po2;
  await step("SLA: pedido antigo sem resposta aparece marcado, no filtro 'Atraso' e nas métricas", async () => {
    db.sql(`set session_replication_role = replica; update public.requests set status = 'RECEBIDO', merged_into_id = null, deleted_at = null, created_at = now() - interval '6 days' where pending_clinic_name = 'Hospital de Olhos de Parnamirim';`);
    await po2.click("nav a:has-text('Solicitações')");
    await po2.waitForSelector("h1:has-text('Solicitações')");
    await po2.selectOption("select[aria-label=Atraso]", "stalled");
    await po2.waitForSelector("text=1 resultado(s)");
    await po2.waitForSelector("tr:has-text('Hospital de Olhos') .sla-tag:has-text('sem resposta')");
    await po2.click("button:has-text('Limpar')");
    await po2.click("nav a:has-text('Métricas')");
    await po2.waitForSelector(".kpi:has-text('Paradas ou sem resposta') strong:has-text('1')");
  });
  await step("importar: admin envia CSV da planilha antiga; repetir não duplica", async () => {
    current = admin;
    await admin.goto(`${BASE}/#/admin/importar`);
    await admin.waitForSelector("h1:has-text('Importar planilha antiga')");
    const csv = [
      "Carimbo de data/hora,Clínica,Nome,Cargo,WhatsApp,Módulo,Título,Descrição,Status",
      '12/03/2025 14:30:00,Kardiomov,Marta Souza,Recepcionista,(84) 99999-1111,Agenda,Bloqueio de horário,"Preciso bloquear horários em lote, por favor",Concluído',
      "13/03/2025 09:00:00,Kardiomov,João Lima,Médico,sem telefone,Financeiro,Relatório mensal,Gostaria de um relatório mensal por convênio,Novo",
      "14/03/2025 09:00:00,,Sem Clínica,Médico,(84) 98888-7777,Financeiro,,,Novo",
    ].join("\n");
    await admin.setInputFiles("#csv", { name: "planilha.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await admin.waitForSelector("text=2 prontas para importar");
    await admin.waitForSelector("text=1 com problema");
    await admin.click("button:has-text('Importar 2 solicitações')");
    await admin.waitForSelector("text=2 criadas");
    await admin.setInputFiles("#csv", { name: "planilha.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await admin.waitForSelector("button:has-text('Importar 2 solicitações')");
    await admin.click("button:has-text('Importar 2 solicitações')");
    await admin.waitForSelector("text=0 criadas");
    await admin.click("nav a:has-text('Solicitações')");
    await admin.waitForSelector("td:has-text('Bloqueio de horário')");
    assert.equal(await admin.locator("td:has-text('Relatório mensal')").count(), 1);
  });
  await step("tema: alterna Automático → Claro → Escuro e lembra depois de recarregar", async () => {
    const t = await newPage();
    await t.goto(`${BASE}/#/solicitar`);
    await t.waitForSelector("button.theme-toggle");
    await t.click("button.theme-toggle");
    assert.equal(await t.getAttribute("html", "data-theme"), "light");
    await t.click("button.theme-toggle");
    assert.equal(await t.getAttribute("html", "data-theme"), "dark");
    const bg = await t.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, "rgb(20, 18, 27)");
    await t.reload();
    await t.waitForSelector("button.theme-toggle");
    assert.equal(await t.getAttribute("html", "data-theme"), "dark");
  });
  await step("acessibilidade: link 'Pular para o conteúdo' leva o foco ao conteúdo", async () => {
    const a = await newPage();
    await a.goto(`${BASE}/#/solicitar`);
    await a.waitForSelector("a.skip-link");
    await a.focus("a.skip-link");
    await a.keyboard.press("Enter");
    assert.equal(await a.evaluate(() => document.activeElement?.id), "conteudo");
  });

  await step("nenhum erro de JavaScript no console durante todo o fluxo", async () => {
    const real = jsErrors.filter((m) => !/favicon|Failed to load resource|signed\.example|ERR_/.test(m));
    assert.deepEqual(real, []);
  });

  console.log(`\n${n} verificações E2E passaram`);
  await finish(0);
})().catch(async (e) => {
  console.error(e);
  await finish(1);
});
