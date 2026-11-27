/**
 * Conceive · envio de e-mails pelo Gmail (Google Apps Script).
 * Use quando você NÃO tem domínio próprio: o e-mail sai da conta Google que implantar este script.
 *
 * Como publicar (passo a passo completo em PASSO_A_PASSO.md, seção 5.1c):
 *  1. Entre em script.google.com com a conta Gmail que será a REMETENTE → Novo projeto → cole este arquivo.
 *  2. Engrenagem “Configurações do projeto” → Propriedades do script → Adicionar: nome SECRET, valor = uma senha longa
 *     (32+ caracteres, só letras e números). A MESMA senha vai no Secret APPS_SCRIPT_SECRET da função notify.
 *  3. Implantar → Nova implantação → tipo “App da Web” → Executar como: Eu → Quem tem acesso: Qualquer pessoa → Implantar.
 *     Autorize o acesso quando o Google pedir. Copie o URL que termina em /exec (vai em APPS_SCRIPT_URL).
 *  4. Se você alterar este código depois, use Implantar → Gerenciar implantações → editar → Nova versão.
 *
 * Limites (contas Gmail comuns): ~100 destinatários por dia. Google Workspace: ~1.500. O script informa a cota restante.
 */
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'invalid_json' }); }

  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret) return out_({ ok: false, error: 'script_sem_SECRET' });
  if (!body || body.secret !== secret) return out_({ ok: false, error: 'unauthorized' });

  var to = [].concat(body.to || []).filter(String);
  if (!to.length || to.length > 50 || !body.subject || !(body.html || body.text)) return out_({ ok: false, error: 'invalid_payload' });

  try {
    var opts = { to: to.join(','), subject: String(body.subject).slice(0, 250), name: String(body.name || 'Conceive').slice(0, 80) };
    if (body.html) opts.htmlBody = String(body.html);
    opts.body = String(body.text || 'Abra este e-mail em um leitor que exiba HTML.');
    if (body.replyTo) opts.replyTo = String(body.replyTo);
    MailApp.sendEmail(opts);
    return out_({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err).slice(0, 200) });
  }
}

// Abrir o URL /exec no navegador mostra este aviso (confirma que a implantação está no ar).
function doGet() { return out_({ ok: true, servico: 'conceive-mail' }); }

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
