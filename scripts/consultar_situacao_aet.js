/**
 * SIAET (DNIT) — Consultar situação de uma AET (menu AET > Consultar)
 *
 * Fluxo coberto:
 *   1. Faz login (reaproveita siaet_login_completo.js)
 *   2. Navega até "AET > Consultar" (manSituacaoAet.asp)
 *   3. Preenche número da AET + ano
 *   4. Resolve o CAPTCHA numérico (mesmo padrão do login/impressão)
 *   5. Envia o formulário e chega em conSituacaoAet.asp com o resultado
 *   6. Extrai situação da tarifa, situação da AET e observação da análise
 *
 * Confirmado via HTML real:
 *   - Mesmo padrão de captcha de 5 dígitos (img#captcha) do login e da
 *     impressão — reaproveita captcha_playwright.js sem alteração.
 *   - O botão de envio é <input type="image"> com o atributo `name`
 *     malformado (aspas soltas, mesmo padrão já visto no login) — por
 *     isso o seletor é por tipo, não por nome.
 *   - A página de resultado (conSituacaoAet.asp) usa uma tabela simples
 *     <tr><td>Rótulo:</td><td>Valor</td></tr> sem ids — a extração usa
 *     o texto do rótulo pra achar a célula vizinha, mais resiliente a
 *     mudanças de layout do que depender de posição/índice fixo.
 *   - O campo "Observação Análise" só aparece quando a AET foi devolvida
 *     para correção — pode não existir em consultas normais.
 *
 * Este script é propositalmente independente do Supabase — devolve os
 * dados extraídos pra quem chamar decidir onde/como persistir (ex:
 * tabela aet_situacoes), permitindo reuso tanto num script de lote
 * quanto futuramente dentro do próprio anexar_aets.js.
 *
 * Pré-requisitos: os mesmos do imprimir_aet.js
 *                  (este arquivo precisa estar na mesma pasta)
 */

require('dotenv').config();

const { chromium } = require('playwright');
const { resolverCaptchaNaPagina } = require('./captcha_playwright.js');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');
const { extrairSituacao } = require('./extrair_situacao_pagina.js');

const TENTATIVAS_MAX_CONSULTA = 100;
const URL_CONSULTA_SIAET = 'https://siaet.dnit.gov.br/manutencao/manSituacaoAet.asp';

// ---------------------------------------------------------------
// PASSO A — Buscar a situação de uma AET específica por número/ano
// ---------------------------------------------------------------
// Mesmo padrão de retry já validado em buscarAetPorNumero (imprimir_aet.js):
// se o OCR não chegar a 5 dígitos ou o site rejeitar o captcha, recarrega
// a página e tenta de novo.

async function buscarSituacaoAetPorNumero(page, numeroAet, anoAet) {
  for (let tentativa = 1; tentativa <= TENTATIVAS_MAX_CONSULTA; tentativa++) {
    console.log(`Consultando situação da AET ${numeroAet}/${anoAet} — tentativa ${tentativa}/${TENTATIVAS_MAX_CONSULTA}...`);

    await page.goto(URL_CONSULTA_SIAET);
    await page.waitForSelector('input[name="txtNUMAet"]');

    await page.fill('input[name="txtNUMAet"]', numeroAet);
    await page.fill('input[name="txtANOAet"]', anoAet);

    let digitosCaptcha;
    try {
      digitosCaptcha = await resolverCaptchaNaPagina(page, 'img#captcha');
    } catch (erroOcr) {
      console.warn(`  OCR falhou: ${erroOcr.message}`);
      if (tentativa === TENTATIVAS_MAX_CONSULTA) throw erroOcr;
      continue; // recarrega a página na próxima iteração
    }

    await page.fill('input[name="securityCode"]', digitosCaptcha);
    await page.click('input[type="image"]');

    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    const urlAtual = page.url();

    if (urlAtual.includes('avisoErro')) {
      console.warn('  Captcha rejeitado — tentando de novo.');
      if (tentativa === TENTATIVAS_MAX_CONSULTA) {
        throw new Error(`Consulta de situação falhou após ${TENTATIVAS_MAX_CONSULTA} tentativas (captcha rejeitado repetidamente).`);
      }
      continue;
    }

    if (urlAtual.includes('conSituacaoAet')) {
      console.log(`  Situação encontrada na tentativa ${tentativa}.`);
      return;
    }

    throw new Error(`URL inesperada após submit na tentativa ${tentativa}: ${urlAtual}`);
  }
}

// ---------------------------------------------------------------
// Atalho: busca + extrai em uma chamada só
// ---------------------------------------------------------------

async function consultarSituacaoAet(page, numeroAet, anoAet) {
  await buscarSituacaoAetPorNumero(page, numeroAet, anoAet);
  return extrairSituacao(page);
}

module.exports = { buscarSituacaoAetPorNumero, consultarSituacaoAet };

// ---------------------------------------------------------------
// EXECUÇÃO — só roda quando este arquivo é chamado diretamente
// ---------------------------------------------------------------

if (require.main === module) {
  // Valores de teste — troque pelos desejados, ou adapte pra ler de
  // argumentos de linha de comando (process.argv), igual sugerido
  // no imprimir_aet.js.
  const NUMERO_AET_TESTE = '410734';
  const ANO_AET_TESTE = '2025';

  (async () => {
    const browser = await chromium.launch({ headless: false, slowMo: 800 });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await fazerLoginCompleto(page);
      console.log('Login concluído — consultando situação...');

      const situacao = await consultarSituacaoAet(page, NUMERO_AET_TESTE, ANO_AET_TESTE);
      console.log('Situação extraída:', situacao);
    } catch (erro) {
      console.error('Falha ao consultar situação:', erro.message);
      await page.screenshot({ path: 'erro-consultar-situacao.png' });
    } finally {
      await browser.close();
    }
  })();
}