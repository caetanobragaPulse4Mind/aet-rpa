/**
 * baixar_boleto.js
 *
 * SIAET (DNIT) — Baixar o(s) BOLETO(s) de uma AET.
 *
 * Script independente do imprimir_aet.js. Mesmo caminho de navegação
 * (manAet.asp?op=emt → captcha → manEmitirBoleto.asp), mas aqui o alvo
 * são os links de boleto, não o botão cmdImprimirAET.
 *
 * Fluxo:
 *   1. Recebe uma `page` JÁ logada no SIAET (quem chama cuida do login)
 *   2. Navega para AET > Imprimir (manAet.asp?op=emt)
 *   3. Resolve o CAPTCHA de 5 dígitos e envia número/ano
 *   4. Chega em manEmitirBoleto.asp
 *   5. Baixa TODOS os boletos com link disponível na tela
 *
 * CONFIRMADO VIA HTML REAL (dois exemplos comparados):
 *
 *   - Boleto EM ABERTO (AET 292712/2026):
 *       <a href="https://siaet.dnit.gov.br/BoletoRegistrado.asp?taxa=...&t=...&a=..."
 *          target="_blank"><img src="printer.png">&nbsp;30430432026296657</a>
 *     Situação da(s) Tarifa(s): "Pagamento da TEAET ainda não foi
 *     efetuado ou foi pago a menor."
 *
 *   - Boleto JÁ PAGO (AET 229767/2026):
 *       o mesmo número aparece como TEXTO PURO, sem <a>.
 *     Situação da(s) Tarifa(s): "Pagamento da TEAET efetuado."
 *
 *   Ou seja: o link só existe enquanto o boleto está em aberto. Depois
 *   de pago não há o que baixar por aqui (só via FINANCEIRO > Segunda
 *   via TEAET). Por isso a ausência de link NÃO é tratada como falha
 *   técnica — é um estado de negócio, devolvido em erro.situacao.
 *
 *   Os parâmetros da URL (taxa, t, a) são hashes ligados à sessão —
 *   não dá para construir a URL, tem que ser lida da página a cada vez.
 *
 * MÚLTIPLOS BOLETOS:
 *   A tela é rotulada "Boleto(s) da AET" e o menu FINANCEIRO trata
 *   TEAET e TUV como tarifas separadas, então a mesma AET pode listar
 *   mais de um boleto. Este script baixa todos os que tiverem link.
 *   Nomeação dos arquivos:
 *     - 1 boleto  → {numero}-{ano}.pdf          (ex: 292712-2026.pdf)
 *     - N boletos → {numero}-{ano}-{numeroBoleto}.pdf
 *   Assim o caso comum mantém o mesmo padrão dos PDFs de AET, e o caso
 *   múltiplo não sobrescreve arquivo.
 *
 * Uso como módulo:
 *   const { baixarBoleto } = require('./baixar_boleto.js');
 *   const r = await baixarBoleto(page, '292712', '2026', '/app/pdfs/boletos');
 *
 * Uso standalone (abre browser e loga sozinho):
 *   node scripts/baixar_boleto.js 292712 2026
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { resolverCaptchaNaPagina, gerarNovoCaptcha } = require('./captcha_playwright.js');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');

const URL_IMPRIMIR_AET = 'https://siaet.dnit.gov.br/manutencao/manAet.asp?op=emt';

const SELETOR_CAPTCHA = 'img#captcha';
const SELETOR_CODIGO = 'input[name="securityCode"]';
const SELETOR_NUMERO = 'input[name="txtNUMAet"]';
const SELETOR_ANO = 'input[name="txtANOAet"]';
// O botão "Enviar" é <input type="image"> e o atributo name veio
// malformado no HTML real (aspas soltas: name="I1&quot;"), por isso o
// seletor é por tipo dentro do form, não por nome.
const SELETOR_ENVIAR = 'form[name="Formulario"] input[type="image"]';

// Links de boleto na tela manEmitirBoleto.asp
const SELETOR_LINK_BOLETO = 'a[href*="BoletoRegistrado.asp"]';

const PASTA_PADRAO = process.env.PASTA_PDFS_BOLETOS || '/app/pdfs/boletos';
const MAX_TENTATIVAS_CAPTCHA = parseInt(process.env.MAX_TENTATIVAS_CAPTCHA, 10) || 10;

// ---------------------------------------------------------------
// Extração da situação direto da página (mesma abordagem de
// innerText + match por rótulo usada no extrair_situacao_pagina.js,
// mas embutida aqui para este script não depender daquele módulo).
// ---------------------------------------------------------------

async function extrairSituacaoDaPagina(page) {
  const texto = await page.evaluate(() => document.body.innerText);
  const linhas = texto.split('\n').map((l) => l.trim());

  function valorDoRotulo(rotulo) {
    const i = linhas.findIndex((l) => l === rotulo || l.startsWith(rotulo));
    if (i === -1) return null;

    // Valor pode estar na mesma linha (depois do rótulo) ou na próxima
    const mesmaLinha = linhas[i].slice(rotulo.length).trim();
    if (mesmaLinha) return mesmaLinha;

    for (let j = i + 1; j < linhas.length; j++) {
      if (linhas[j]) return linhas[j];
    }
    return null;
  }

  return {
    situacaoTarifa: valorDoRotulo('Situação da(s) Tarifa(s):'),
    situacaoAet: valorDoRotulo('Situação da AET:'),
    observacaoAnalise: valorDoRotulo('Observação Análise:'),
  };
}

// ---------------------------------------------------------------
// Navegação até manEmitirBoleto.asp resolvendo o captcha
// ---------------------------------------------------------------

async function abrirTelaDoBoleto(page, numero, ano) {
  await page.goto(URL_IMPRIMIR_AET, { waitUntil: 'domcontentloaded' });

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CAPTCHA; tentativa++) {
    console.log(`  Captcha — tentativa ${tentativa}/${MAX_TENTATIVAS_CAPTCHA}...`);

    let codigo;
    try {
      codigo = await resolverCaptchaNaPagina(page, SELETOR_CAPTCHA);
    } catch (erroOcr) {
      // OCR não conseguiu ler: pede uma imagem nova e tenta de novo,
      // sem gastar uma submissão no site.
      console.log(`  OCR falhou: ${erroOcr.message}`);
      await gerarNovoCaptcha(page, SELETOR_CAPTCHA);
      continue;
    }

    await page.fill(SELETOR_CODIGO, codigo);
    await page.fill(SELETOR_NUMERO, String(numero));
    await page.fill(SELETOR_ANO, String(ano));

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click(SELETOR_ENVIAR),
    ]);

    const url = page.url();

    // ATENÇÃO à caixa: 'avisoErro.asp' (a minúsculo) = captcha recusado.
    // 'AvisoErro.asp?dsc_erro=' (A maiúsculo) = erro de negócio da AET
    // (cancelada, em digitação, etc) com descrição extraível.
    if (url.includes('AvisoErro.asp')) {
      const descricao = decodeURIComponent(
        (url.split('dsc_erro=')[1] || '').split('&')[0]
      ).replace(/\+/g, ' ').replace(/<br>/gi, ' ').trim();

      const erro = new Error(`AET ${numero}/${ano}: ${descricao || 'erro informado pelo SIAET'}`);
      erro.situacao = { situacaoAet: descricao || null, situacaoTarifa: null, observacaoAnalise: null };
      throw erro;
    }

    if (url.includes('avisoErro.asp')) {
      console.log('  Captcha recusado pelo SIAET — nova tentativa.');
      await page.goto(URL_IMPRIMIR_AET, { waitUntil: 'domcontentloaded' });
      continue;
    }

    if (url.includes('manEmitirBoleto.asp')) {
      console.log('  Tela de boleto alcançada.');
      return;
    }

    throw new Error(`URL inesperada após enviar o formulário: ${url}`);
  }

  throw new Error(
    `Não foi possível resolver o captcha em ${MAX_TENTATIVAS_CAPTCHA} tentativas.`
  );
}

// ---------------------------------------------------------------
// Download do PDF a partir de um link de boleto
//
// BoletoRegistrado.asp pode responder com o PDF direto ou com uma
// página HTML do boleto. Em vez de assumir, o script inspeciona o
// content-type e trata os dois casos:
//   - application/pdf  → grava os bytes recebidos
//   - text/html        → abre numa aba e gera o PDF via page.pdf()
//
// A requisição sai por page.request, que compartilha os cookies do
// contexto (a sessão do SIAET), com o Referer da própria tela — o
// backend ASP do SIAET é sensível a Referer em várias telas.
// ---------------------------------------------------------------

async function baixarPdfDoLink(page, urlBoleto, caminhoPdf) {
  const resposta = await page.request.get(urlBoleto, {
    headers: { Referer: page.url() },
  });

  if (!resposta.ok()) {
    throw new Error(
      `BoletoRegistrado.asp respondeu HTTP ${resposta.status()} ${resposta.statusText()}`
    );
  }

  const tipo = (resposta.headers()['content-type'] || '').toLowerCase();

  if (tipo.includes('pdf')) {
    fs.writeFileSync(caminhoPdf, await resposta.body());
    return 'pdf-direto';
  }

  if (tipo.includes('html')) {
    // Boleto servido como página: abre numa aba nova (para não perder
    // a tela atual) e imprime em PDF.
    const abaBoleto = await page.context().newPage();
    try {
      await abaBoleto.goto(urlBoleto, { waitUntil: 'networkidle' });
      await abaBoleto.pdf({ path: caminhoPdf, format: 'A4', printBackground: true });
    } finally {
      await abaBoleto.close();
    }
    return 'html-convertido';
  }

  throw new Error(`Content-Type inesperado em BoletoRegistrado.asp: "${tipo}"`);
}

// ---------------------------------------------------------------
// Lê todos os links de boleto da tela.
//
// Coleta href + número ANTES de baixar qualquer coisa: assim o
// download de um boleto não invalida os locators dos outros (e o
// resultado fica previsível mesmo se a página mudar no meio).
// ---------------------------------------------------------------

async function coletarLinksDeBoleto(page) {
  return page.$$eval(SELETOR_LINK_BOLETO, (links) =>
    links.map((a) => ({
      url: a.href,
      // O texto do link é o número do boleto no SIAET
      // (ex: 30430432026296657) — chave estável para nomear
      // o arquivo e, no futuro, deduplicar no banco.
      numeroBoleto: (a.innerText || '').replace(/\D/g, '') || null,
    }))
  );
}

// ---------------------------------------------------------------
// Função principal — recebe page JÁ logada.
//
// Retorna { boletos: [...], situacaoTarifa, situacaoAet }, onde cada
// item de `boletos` tem { numeroBoleto, caminhoPdf, modo }.
// ---------------------------------------------------------------

async function baixarBoleto(page, numero, ano, pastaDestino = PASTA_PADRAO) {
  fs.mkdirSync(pastaDestino, { recursive: true });

  await abrirTelaDoBoleto(page, numero, ano);

  const links = await coletarLinksDeBoleto(page);
  const situacao = await extrairSituacaoDaPagina(page);

  if (links.length === 0) {
    // Sem link = boleto já pago, ou AET sem boleto emitido. Estado de
    // negócio, não falha do robô: devolve a situação lida da tela para
    // o chamador registrar (mesmo contrato do imprimir_aet.js).
    const erro = new Error(
      `AET ${numero}/${ano}: nenhum boleto com link na tela. ` +
      `Situação da tarifa: ${situacao.situacaoTarifa || 'não informada'}`
    );
    erro.situacao = situacao;
    erro.semBoletoDisponivel = true;
    throw erro;
  }

  console.log(`  ${links.length} boleto(s) com link disponível.`);

  const baixados = [];

  for (const link of links) {
    // Um boleto: mantém o padrão dos PDFs de AET ({numero}-{ano}.pdf).
    // Mais de um: sufixa com o número do boleto para não sobrescrever.
    const nomeArquivo =
      links.length === 1
        ? `${numero}-${ano}.pdf`
        : `${numero}-${ano}-${link.numeroBoleto || baixados.length + 1}.pdf`;

    const caminhoPdf = path.join(pastaDestino, nomeArquivo);

    const modo = await baixarPdfDoLink(page, link.url, caminhoPdf);
    console.log(`  → ${nomeArquivo} (${modo})`);

    baixados.push({ numeroBoleto: link.numeroBoleto, caminhoPdf, modo });
  }

  return {
    boletos: baixados,
    situacaoTarifa: situacao.situacaoTarifa,
    situacaoAet: situacao.situacaoAet,
  };
}

// ---------------------------------------------------------------
// Execução standalone: node scripts/baixar_boleto.js 292712 2026
// ---------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const [, , numeroArg, anoArg] = process.argv;
    if (!numeroArg || !anoArg) {
      console.error('Uso: node scripts/baixar_boleto.js <numero> <ano>');
      process.exit(1);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      console.log('Fazendo login no SIAET...');
      await fazerLoginCompleto(page);
      console.log('Login concluído.');

      console.log(`Baixando boleto(s) da AET ${numeroArg}/${anoArg}...`);
      const resultado = await baixarBoleto(page, numeroArg, anoArg);

      console.log(`\n✅ ${resultado.boletos.length} boleto(s) salvo(s):`);
      for (const b of resultado.boletos) {
        const tamanho = (fs.statSync(b.caminhoPdf).size / 1024).toFixed(0);
        console.log(`   ${b.caminhoPdf} — ${tamanho} KB — nº ${b.numeroBoleto} (${b.modo})`);
      }
      console.log(`   Situação da tarifa: ${resultado.situacaoTarifa}`);
    } catch (erro) {
      if (erro.semBoletoDisponivel) {
        console.log(`\nℹ️  ${erro.message}`);
      } else {
        console.error(`\n❌ Falha: ${erro.message}`);
      }
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  })();
}

module.exports = { baixarBoleto };