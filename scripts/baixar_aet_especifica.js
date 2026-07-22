/**
 * testar_aet_especifica.js
 *
 * Script de DIAGNÓSTICO, isolado do fluxo de produção. Objetivo: reproduzir
 * o caso de 20/07 onde o RPA chegou na tela "Emitir Boleto" sem o botão
 * "Clique aqui para imprimir a Autorização Especial de Trânsito"
 * (cmdImprimirAET), mas o acesso manual ao mesmo AET baixava normalmente.
 *
 * NÃO reimplementa login nem captcha — importa e usa
 * `fazerLoginCompleto` (siaet_login_completo.js) e `imprimirAet`
 * (imprimir_aet.js) exatamente como já funcionam em produção. A única
 * coisa nova aqui é a INSTRUMENTAÇÃO em volta dessas chamadas:
 *
 *   1. Fingerprint do browser (navigator.webdriver, user-agent, viewport)
 *      antes e depois do login — pra ver se o Playwright headless está
 *      deixando rastro que um Chrome comum não deixaria.
 *   2. Se imprimirAet() falhar, verifica o DOM CRU pelo seletor real do
 *      botão (input[name="cmdImprimirAET"], confirmado no HTML salvo de
 *      manEmitirBoleto.asp) — independente do que o Playwright/imprimir_aet.js
 *      já decidiu. Isso separa dois cenários bem diferentes:
 *        a) botão não existe no DOM => pendência de negócio real (mesmo
 *           painel de "Situação da AET" / "Observação Análise" que
 *           aparece pra AET devolvida/proprietário-carga/etc)
 *        b) botão existe mas com display:none / visibility:hidden /
 *           tamanho zero => algo no site está escondendo ele DESTE
 *           browser especificamente (fingerprint de automação, IP,
 *           timing de JS, etc) — não é uma pendência real
 *   3. Screenshot full-page + HTML completo da tela no momento da falha,
 *      pra você conferir visualmente depois.
 *
 * Uso:
 *   node scripts/testar_aet_especifica.js 280601 2026
 *   (sem argumentos, roda com 280601/2026 por padrão)
 *
 * Saída (pasta ./diagnostico/, criada automaticamente):
 *   280601-2026.pdf          (se der certo)
 *   280601-2026-falha.png    (se der errado)
 *   280601-2026-falha.html   (se der errado)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { fazerLoginCompleto } = require('./siaet_login_completo.js');
const { imprimirAet } = require('./imprimir_aet.js');

// Fica dentro do volume aet-rpa_aet-rpa-pdfs (montado em /app/pdfs), não na
// camada de escrita do container — assim sobrevive a rebuild/restart/update
// do serviço. Mesmo padrão de env var usado no anexar_aets.js.
const PASTA_DIAG = process.env.PASTA_DIAGNOSTICO || '/app/pdfs/diagnostico';

// User-Agent de um Chrome desktop comum — o Playwright headless por padrão
// já manda um UA plausível, mas fixar explicitamente remove qualquer
// variação entre versões do Chromium embutido e o Chrome real que você
// usa manualmente.
const USER_AGENT_REAL =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------
// Diagnóstico de fingerprint — só leitura, não altera nada na página.
// ---------------------------------------------------------------
async function lerFingerprint(page) {
  return page.evaluate(() => ({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    idiomas: navigator.languages,
    qtdPlugins: navigator.plugins ? navigator.plugins.length : null,
    viewport: { largura: window.innerWidth, altura: window.innerHeight },
  }));
}

// ---------------------------------------------------------------
// Verifica o botão cmdImprimirAET direto no DOM, sem passar pelas
// heurísticas de visibilidade do Playwright. Retorna null se a página
// nem tiver esse elemento em lugar nenhum (pendência real, provavelmente).
// ---------------------------------------------------------------
async function checarBotaoImprimir(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('input[name="cmdImprimirAET"]');
    if (!btn) return { existeNoDOM: false };

    const estilo = window.getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();

    return {
      existeNoDOM: true,
      display: estilo.display,
      visibility: estilo.visibility,
      opacity: estilo.opacity,
      largura: rect.width,
      altura: rect.height,
      dentroDaTela: rect.width > 0 && rect.height > 0,
      htmlBotao: btn.outerHTML,
    };
  });
}

// ---------------------------------------------------------------
// Núcleo do teste
// ---------------------------------------------------------------
async function testarAetEspecifica(numero, ano) {
  fs.mkdirSync(PASTA_DIAG, { recursive: true });
  const nomeBase = `${numero}-${ano}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: USER_AGENT_REAL,
  });

  // Remove o sinalizador mais óbvio de automação. Sites que checam
  // `navigator.webdriver === true` (padrão do Chromium automatizado)
  // podem servir conteúdo diferente sem nem precisar de outros sinais.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    console.log('--- Fingerprint ANTES do login ---');
    console.log(await lerFingerprint(page));

    console.log('\nFazendo login no SIAET...');
    await fazerLoginCompleto(page);
    console.log('Login concluído.');

    console.log('\n--- Fingerprint DEPOIS do login ---');
    console.log(await lerFingerprint(page));

    const caminhoPdf = path.join(PASTA_DIAG, `${nomeBase}.pdf`);

    console.log(`\nTentando gerar PDF da AET ${numero}/${ano}...`);
    try {
      await imprimirAet(page, numero, ano, caminhoPdf);
      console.log(`\n✅ SUCESSO — PDF salvo em: ${caminhoPdf}`);
    } catch (erro) {
      console.error(`\n❌ imprimirAet falhou: ${erro.message}`);
      console.log('URL no momento da falha:', page.url());

      if (erro.situacao) {
        console.log('\nSituação extraída da própria página (pendência já identificada):');
        console.log(erro.situacao);
      }

      console.log('\n--- Verificação direta do botão cmdImprimirAET no DOM ---');
      const botao = await checarBotaoImprimir(page);
      console.log(JSON.stringify(botao, null, 2));

      const caminhoScreenshot = path.join(PASTA_DIAG, `${nomeBase}-falha.png`);
      await page.screenshot({ path: caminhoScreenshot, fullPage: true });
      console.log(`\nScreenshot salvo em: ${caminhoScreenshot}`);

      const caminhoHtml = path.join(PASTA_DIAG, `${nomeBase}-falha.html`);
      fs.writeFileSync(caminhoHtml, await page.content());
      console.log(`HTML completo da tela salvo em: ${caminhoHtml}`);
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------
// Execução direta: node scripts/testar_aet_especifica.js [numero] [ano]
// ---------------------------------------------------------------
if (require.main === module) {
  const [, , numeroArg, anoArg] = process.argv;
  const numero = numeroArg || '280601';
  const ano = anoArg || '2026';

  testarAetEspecifica(numero, ano).catch((erro) => {
    console.error('Erro fatal no teste:', erro.message);
    process.exit(1);
  });
}

module.exports = { testarAetEspecifica };