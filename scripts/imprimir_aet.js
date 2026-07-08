/**
 * SIAET (DNIT) — Buscar AET por número/ano e baixar o PDF
 *
 * Fluxo coberto:
 *   1. Faz login (reaproveita siaet_login_completo.js)
 *   2. Navega até "AET > Imprimir" (manAet.asp?op=emt)
 *   3. Preenche número da AET + ano
 *   4. Resolve o CAPTCHA numérico (mesmo padrão do login)
 *   5. Envia o formulário e chega na tela "Emitir Boleto"
 *   6. Clica em "Imprimir AET" — abre um popup que serve o PDF
 *   7. Captura o evento de download e salva o arquivo localmente
 *
 * Confirmado via HTML real:
 *   - O captcha aqui é o MESMO padrão de 5 dígitos do login (mesma
 *     imagem id="captcha"). Único campo de destino diferente: aqui
 *     só tem `name="securityCode"`, sem `id` como no login.
 *   - O botão "Enviar" é um <input type="image"> — o atributo
 *     `name` veio malformado no HTML real (aspas soltas), por isso
 *     o seletor usado é por tipo, não por nome.
 *   - O botão "Imprimir AET" (cmdImprimirAET) chama uma função JS
 *     própria do site (OpenModalWindow) que por baixo é um
 *     window.open() — abre como janela popup separada, apontando
 *     direto para um endpoint que serve o PDF puro. Em modo
 *     headless, o Chromium do Playwright não tem visualizador de
 *     PDF embutido, então essa navegação dispara um evento de
 *     download automaticamente.
 *
 * AINDA NÃO TESTADO contra o site real (diferente do fluxo de
 * login). Por isso, sem retentativa automática nesta versão — se o
 * captcha for rejeitado aqui também, dá pra aplicar o mesmo padrão
 * já validado em loginSiaet, uma vez confirmado como é a tela de
 * erro nesse contexto específico.
 *
 * Pré-requisitos: os mesmos do siaet_login_completo.js
 *                  (este arquivo precisa estar na mesma pasta)
 */

require('dotenv').config();

const { chromium } = require('playwright');
const { resolverCaptchaNaPagina } = require('./captcha_playwright.js');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');

// ---------------------------------------------------------------
// PASSO A — Buscar uma AET específica por número/ano
// ---------------------------------------------------------------
// Usa o mesmo padrão de retry do login: se o OCR não chegar a 5
// dígitos ou o site rejeitar o captcha, recarrega a página e tenta
// de novo. Recarregar é mais simples do que tentar regenerar o
// captcha in-place — garante formulário limpo a cada tentativa.

const TENTATIVAS_MAX_BUSCA = 100;
const URL_BUSCA = 'https://siaet.dnit.gov.br/manutencao/manAet.asp?op=emt';

async function buscarAetPorNumero(page, numeroAet, anoAet) {
  for (let tentativa = 1; tentativa <= TENTATIVAS_MAX_BUSCA; tentativa++) {
    console.log(`Buscando AET ${numeroAet}/${anoAet} — tentativa ${tentativa}/${TENTATIVAS_MAX_BUSCA}...`);

    await page.goto(URL_BUSCA);
    await page.waitForSelector('input[name="txtNUMAet"]');

    await page.fill('input[name="txtNUMAet"]', numeroAet);
    await page.fill('input[name="txtANOAet"]', anoAet);

    let digitosCaptcha;
    try {
      digitosCaptcha = await resolverCaptchaNaPagina(page, 'img#captcha');
    } catch (erroOcr) {
      console.warn(`  OCR falhou: ${erroOcr.message}`);
      if (tentativa === TENTATIVAS_MAX_BUSCA) throw erroOcr;
      continue; // recarrega a página na próxima iteração
    }

    await page.fill('input[name="securityCode"]', digitosCaptcha);
    await page.click('input[type="image"]');

    // Aguarda a navegação pós-submit — o site vai para uma das duas URLs:
    //   avisoErro.asp  → captcha errado (confirmado via HTML real da página de erro)
    //   manEmitirBoleto ou similar → sucesso (botão cmdImprimirAET aparece)
    // Checar a URL é mais confiável que Promise.race com múltiplas detecções
    // de elemento (evita race condition entre timeouts concorrentes).
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    const urlAtual = page.url();

    if (urlAtual.includes('avisoErro')) {
      console.warn('  Captcha rejeitado — tentando de novo.');
      if (tentativa === TENTATIVAS_MAX_BUSCA) {
        throw new Error(`Busca de AET falhou após ${TENTATIVAS_MAX_BUSCA} tentativas (captcha rejeitado repetidamente).`);
      }
      continue; // goto(URL_BUSCA) no topo do próximo loop recarrega tudo
    }

    // Confirma que o botão de imprimir está presente na página resultante
    const btnImprimir = page.locator('input[name="cmdImprimirAET"]');
    if (await btnImprimir.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log(`  AET encontrada na tentativa ${tentativa}.`);
      return;
    }

    // URL inesperada — não é erro de captcha nem sucesso conhecido
    throw new Error(`URL inesperada após submit na tentativa ${tentativa}: ${urlAtual}`);
  }
}

// ---------------------------------------------------------------
// PASSO B — Gerar PDF a partir da tela de impressão da AET
// ---------------------------------------------------------------
// Confirmado via vídeo: cmdImprimirAET abre um popup com uma página
// HTML da AET (aet_cie_f02_v5.asp) — NÃO é um download de arquivo.
// O Playwright resolve isso com page.pdf(), que gera um PDF a partir
// do conteúdo da página em modo headless, sem precisar de diálogo
// de impressão nem evento de download.

async function baixarPdfAet(page, caminhoSalvar) {
  const popupPromise = page.waitForEvent('popup');
  await page.click('input[name="cmdImprimirAET"]');
  const popup = await popupPromise;

  // Aguarda o conteúdo da AET carregar completamente antes de gerar o PDF
  await popup.waitForLoadState('networkidle');

  await popup.pdf({
    path: caminhoSalvar,
    format: 'A4',
    printBackground: true,  // preserva as cores e bordas da tabela
  });

  await popup.close().catch(() => {});
  console.log(`PDF salvo em: ${caminhoSalvar}`);
}

// ---------------------------------------------------------------
// Atalho: busca + baixa em uma chamada só
// ---------------------------------------------------------------

async function imprimirAet(page, numeroAet, anoAet, caminhoSalvar) {
  await buscarAetPorNumero(page, numeroAet, anoAet);
  await baixarPdfAet(page, caminhoSalvar);
}

module.exports = { buscarAetPorNumero, baixarPdfAet, imprimirAet };

// ---------------------------------------------------------------
// EXECUÇÃO — só roda quando este arquivo é chamado diretamente
// ---------------------------------------------------------------

if (require.main === module) {
  // Número/ano de teste (AET real vista no print/vídeo enviados).
  // Para uso real, troque pelos valores desejados — ou adapte para
  // ler de argumentos de linha de comando (process.argv).
  const NUMERO_AET_TESTE = '229767';
  const ANO_AET_TESTE = '2026';
  const CAMINHO_PDF_TESTE = `.AETS/aet-${NUMERO_AET_TESTE}-${ANO_AET_TESTE}.pdf`;

  (async () => {
    const browser = await chromium.launch({ headless: false, slowMo: 800 });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    try {
      await fazerLoginCompleto(page);
      console.log('Login concluído — buscando AET...');

      await imprimirAet(page, NUMERO_AET_TESTE, ANO_AET_TESTE, CAMINHO_PDF_TESTE);
    } catch (erro) {
      console.error('Falha ao imprimir AET:', erro.message);
      await page.screenshot({ path: 'erro-imprimir-aet.png' });
    } finally {
      await browser.close();
    }
  })();
}