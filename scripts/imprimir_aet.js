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
 *   - Quando a AET foi devolvida para correção (ou tem outra
 *     pendência), a tela manEmitirBoleto.asp NÃO tem o botão
 *     cmdImprimirAET — em vez disso mostra o mesmo painel de
 *     "Situação da AET" / "Observação Análise" da tela de consulta
 *     (conSituacaoAet.asp). Nesse caso, extraímos esses dados da
 *     própria página (sem captcha extra) em vez de só reportar erro
 *     genérico de URL inesperada — ver extrair_situacao_pagina.js.
 *
 * Pré-requisitos: os mesmos do siaet_login_completo.js
 *                  (este arquivo precisa estar na mesma pasta)
 */

require('dotenv').config();

const { chromium } = require('playwright');
const { resolverCaptchaNaPagina } = require('./captcha_playwright.js');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');
const { extrairSituacao, extrairPendenciaProprietario } = require('./extrair_situacao_pagina.js');

// ---------------------------------------------------------------
// PASSO A — Buscar uma AET específica por número/ano
// ---------------------------------------------------------------
// Usa o mesmo padrão de retry do login: se o OCR não chegar a 5
// dígitos ou o site rejeitar o captcha, recarrega a página e tenta
// de novo. Recarregar é mais simples do que tentar regenerar o
// captcha in-place — garante formulário limpo a cada tentativa.

const TENTATIVAS_MAX_BUSCA = 100;

// Confirmado pelo usuário: acessando manualmente via menu AET > Imprimir,
// a tela mostra o botão de imprimir normalmente para uma AET liberada.
// Só quando o script chegava direto via page.goto(URL_BUSCA) é que a
// mesma AET caía na tela de "Observação Análise" preenchida (bloqueio),
// sem o botão — mesmo padrão de Referer ausente já mapeado em
// popular_aets.js/incrementar_aets.js para a listagem de AETs. Por isso
// aqui também trocamos page.goto() por navegação real via clique de
// menu, que é o que estabelece o Referer/estado de sessão esperado
// pelo backend ASP.
async function navegarParaImprimir(page) {
  await page.getByText('AET', { exact: true }).click();
  await page.getByText('Imprimir', { exact: true }).click();
  await page.waitForSelector('input[name="txtNUMAet"]');
}

async function buscarAetPorNumero(page, numeroAet, anoAet) {
  for (let tentativa = 1; tentativa <= TENTATIVAS_MAX_BUSCA; tentativa++) {
    console.log(`Buscando AET ${numeroAet}/${anoAet} — tentativa ${tentativa}/${TENTATIVAS_MAX_BUSCA}...`);

    await navegarParaImprimir(page);

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
      continue; // navegarParaImprimir(page) no topo do próximo loop recarrega tudo, via clique real de menu
    }

    // --- DEBUG TEMPORÁRIO — remover depois de diagnosticar ---
    // Salva a URL exata + o HTML completo da página assim que chega
    // aqui, ANTES de checar o botão. Objetivo: comparar linha a linha
    // com o HTML salvo manualmente e achar a diferença real entre a
    // sessão do script e a sessão manual pra mesma AET.
    const fsDebug = require('fs');
    fsDebug.writeFileSync(
      `debug-pagina-${tentativa}.html`,
      `<!-- URL: ${urlAtual} -->\n${await page.content()}`
    );
    console.log(`  [DEBUG] HTML salvo em debug-pagina-${tentativa}.html — URL: ${urlAtual}`);
    // --- fim do debug temporário ---

    // Confirma que o botão de imprimir está presente na página resultante.
    // Timeout de 15s: dá margem suficiente pro elemento renderizar em
    // conexões mais lentas antes de considerar que ele realmente não existe.
    const btnImprimir = page.locator('input[name="cmdImprimirAET"]');
    if (await btnImprimir.isVisible({ timeout: 15000 }).catch(() => false)) {
      console.log(`  AET encontrada na tentativa ${tentativa}.`);
      return;
    }

    // Botão não apareceu — antes de assumir erro genérico, tenta extrair
    // o painel de "Situação da AET" da própria página (sem captcha extra).
    // IMPORTANTE: "Situação da AET" e "Situação da(s) Tarifa(s)" são
    // texto fixo do template desta tela (confirmado: mesmo texto com
    // e sem o botão de imprimir presente) — não servem pra decidir se
    // há pendência real. Só a "Observação Análise" é confiável: vazia
    // quando não há bloqueio, preenchida quando há.
    const situacao = await extrairSituacao(page);
    if (situacao.observacaoAnalise) {
      // Observação Análise preenchida = SIAET está de fato reportando
      // um bloqueio real (tarifa, devolução, etc) — pendência de
      // negócio legítima.
      const erroSituacao = new Error(situacao.situacaoAet || situacao.observacaoAnalise);
      erroSituacao.situacao = situacao;
      throw erroSituacao;
    }
    // Sem Observação Análise: o SIAET não reportou nenhum bloqueio real,
    // então o botão não ter sido encontrado é uma falha TÉCNICA (ex:
    // timing, seletor, mudança de layout) — não anexamos erro.situacao
    // aqui, pra não virar pendência falsa em aet_situacoes. Isso cai no
    // erro genérico lá embaixo, que já gera screenshot em anexar_aets.js
    // (útil pra diagnosticar o que a página realmente mostrava).

    // Não é devolução — tenta o outro caso conhecido: pendência de
    // dados do proprietário da carga (manProprietarioCarga.asp).
    const pendenciaProprietario = await extrairPendenciaProprietario(page);
    if (pendenciaProprietario) {
      const erroPendencia = new Error(pendenciaProprietario.situacaoAet);
      erroPendencia.situacao = pendenciaProprietario;
      throw erroPendencia;
    }

    // Nem captcha errado, nem sucesso, nem painel de situação reconhecido
    // — situação realmente não mapeada ainda.
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
  const NUMERO_AET_TESTE = '289046';
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
      if (erro.situacao) {
        console.error('Situação extraída:', erro.situacao);
      }
      await page.screenshot({ path: 'erro-imprimir-aet.png' });
    } finally {
      await browser.close();
    }
  })();
}