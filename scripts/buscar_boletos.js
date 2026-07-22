/**
 * buscar_boletos.js
 *
 * SIAET (DNIT) — Lote de download de boletos.
 *
 * Descobre quais AETs têm boleto em aberto usando a tela
 * FINANCEIRO > Débitos (conDebitoTransportador.asp) e chama o
 * baixar_boleto.js para cada uma.
 *
 * POR QUE PARTIR DA TELA DE DÉBITOS:
 *   Ela lista as AETs com débito em aberto SEM exigir captcha — é só
 *   navegação de menu. Só se gasta captcha nas AETs que realmente têm
 *   boleto a baixar (um por AET, na manEmitirBoleto.asp). Varrer o
 *   banco inteiro tentando cada AET desperdiçaria OCR em massa, e o
 *   captcha dessa tela é justamente o de menor taxa de acerto.
 *
 * ESTRUTURA DA TELA DE DÉBITOS (confirmada em HTML real):
 *   <table id="tblRelatorioDiario">
 *     linha de cabeçalho: AET Número | Tipo Débito | Data de Vencimento | Valor
 *     linhas de dados:    292712/2026 | Tarifa de AET | 23/07/2026 | 91,48
 *     linha final:        TOTAL (colspan=3) | 91,48
 *
 *   O parser aceita apenas linhas cuja primeira célula bate com
 *   NNNNNN/AAAA — assim cabeçalho e TOTAL são descartados sozinhos,
 *   sem depender de índice de linha.
 *
 *   ATENÇÃO: o HTML de referência é de um transportador SEM débitos
 *   impeditivos ("Transportador não possuí débitos impeditivos..."),
 *   então só uma tabela foi renderizada. Se houver débitos vencidos, o
 *   SIAET provavelmente renderiza uma segunda tabela. O seletor usa
 *   querySelectorAll, que captura TODAS as tabelas com esse id (ASP
 *   costuma repetir id), então os dois casos entram no lote. Vale
 *   confirmar com um HTML real de transportador com débito vencido.
 *
 * IDEMPOTÊNCIA:
 *   Antes de gastar captcha, verifica se o PDF já existe em disco e
 *   pula a AET. Use REBAIXAR=1 para forçar o download mesmo assim.
 *   (Não há integração com Supabase aqui — este script só baixa. A
 *   gravação em `boletos` fica para a camada de banco.)
 *
 * Uso:
 *   node scripts/buscar_boletos.js
 *   LIMITE_TESTE=2 node scripts/buscar_boletos.js
 *   REBAIXAR=1 node scripts/buscar_boletos.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { fazerLoginCompleto } = require('./siaet_login_completo.js');
const { baixarBoleto } = require('./baixar_boleto.js');

const URL_DEBITOS = 'https://siaet.dnit.gov.br/manutencao/conDebitoTransportador.asp';
const SELETOR_TABELA = 'table#tblRelatorioDiario';
const SELETOR_MENU_DEBITOS = 'a[href*="conDebitoTransportador.asp"]';

const PASTA_BOLETOS = process.env.PASTA_PDFS_BOLETOS || '/app/pdfs/boletos';
const REBAIXAR = process.env.REBAIXAR === '1';

// ---------------------------------------------------------------
// Navegação até a tela de Débitos.
//
// O backend ASP do SIAET é sensível ao Referer: em várias telas o
// page.goto() direto devolve resultado vazio, enquanto a navegação
// disparada por um clique real no menu funciona. Por isso a ordem é:
// clicar no link do menu primeiro (via evaluate, porque o dropdown
// está escondido por CSS e o Playwright recusaria o clique), e só
// cair no goto direto se o link não existir na página atual.
// ---------------------------------------------------------------

async function abrirTelaDeDebitos(page) {
  const temLinkNoMenu = (await page.locator(SELETOR_MENU_DEBITOS).count()) > 0;

  if (temLinkNoMenu) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.evaluate((sel) => document.querySelector(sel).click(), SELETOR_MENU_DEBITOS),
    ]);
  } else {
    await page.goto(URL_DEBITOS, { waitUntil: 'domcontentloaded' });
  }

  if (!page.url().includes('conDebitoTransportador.asp')) {
    throw new Error(`Não chegou na tela de Débitos. URL atual: ${page.url()}`);
  }
}

// ---------------------------------------------------------------
// Parser da tabela de débitos
// ---------------------------------------------------------------

async function lerDebitos(page) {
  return page.$$eval(`${SELETOR_TABELA} tr`, (linhas) => {
    const resultado = [];

    for (const linha of linhas) {
      const celulas = Array.from(linha.querySelectorAll('td')).map((td) =>
        (td.innerText || '').replace(/\u00a0/g, ' ').trim()
      );

      // Só interessam linhas cuja 1ª célula é um número de AET.
      // Cabeçalho ("AET Número") e rodapé ("TOTAL") caem fora sozinhos.
      if (celulas.length < 4) continue;
      if (!/^\d+\/\d{4}$/.test(celulas[0])) continue;

      resultado.push({
        numeroAet: celulas[0],
        tipoDebito: celulas[1] || null,
        dataVencimento: celulas[2] || null,
        valor: celulas[3] || null,
      });
    }

    return resultado;
  });
}

// ---------------------------------------------------------------
// Uma AET pode aparecer em mais de uma linha da tela de Débitos
// (tarifas diferentes vencendo em datas diferentes). Como o
// baixar_boleto.js já baixa TODOS os boletos com link da tela em uma
// única visita, agrupamos por AET para não gastar dois captchas
// buscando a mesma página duas vezes.
// ---------------------------------------------------------------

function agruparPorAet(debitos) {
  const mapa = new Map();
  for (const d of debitos) {
    if (!mapa.has(d.numeroAet)) mapa.set(d.numeroAet, []);
    mapa.get(d.numeroAet).push(d);
  }
  return mapa;
}

function splitNumeroAet(numeroAet) {
  const [numero, ano] = String(numeroAet).split('/');
  if (!numero || !ano) {
    throw new Error(`Formato inesperado de número de AET: "${numeroAet}"`);
  }
  return { numero, ano };
}

function jaBaixado(numero, ano) {
  // Nome do caso simples (1 boleto). Se a AET tiver vários, o
  // baixar_boleto.js grava com sufixo — por isso a checagem olha
  // também por qualquer arquivo que comece com {numero}-{ano}.
  if (fs.existsSync(path.join(PASTA_BOLETOS, `${numero}-${ano}.pdf`))) return true;

  if (!fs.existsSync(PASTA_BOLETOS)) return false;
  return fs
    .readdirSync(PASTA_BOLETOS)
    .some((arquivo) => arquivo.startsWith(`${numero}-${ano}-`) && arquivo.endsWith('.pdf'));
}

// ---------------------------------------------------------------
// Execução
// ---------------------------------------------------------------

(async () => {
  fs.mkdirSync(PASTA_BOLETOS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    console.log('Fazendo login no SIAET...');
    await fazerLoginCompleto(page);
    console.log('Login concluído.');

    console.log('Abrindo FINANCEIRO > Débitos...');
    await abrirTelaDeDebitos(page);

    const debitos = await lerDebitos(page);
    console.log(`${debitos.length} linha(s) de débito na tela.`);

    if (debitos.length === 0) {
      console.log('Nenhum débito em aberto — nada a baixar.');
      return;
    }

    let aets = Array.from(agruparPorAet(debitos).entries());
    console.log(`${aets.length} AET(s) distinta(s) com débito.`);

    const limiteTeste = parseInt(process.env.LIMITE_TESTE, 10);
    if (Number.isInteger(limiteTeste) && limiteTeste > 0) {
      console.log(`LIMITE_TESTE ativo — processando só ${limiteTeste} de ${aets.length}.`);
      aets = aets.slice(0, limiteTeste);
    }

    let sucesso = 0;
    let pulados = 0;
    let semBoleto = 0;
    let falha = 0;

    for (let i = 0; i < aets.length; i++) {
      const [numeroAet, linhas] = aets[i];
      const rotulo = `[${i + 1}/${aets.length}] ${numeroAet}`;

      try {
        const { numero, ano } = splitNumeroAet(numeroAet);

        if (!REBAIXAR && jaBaixado(numero, ano)) {
          console.log(`${rotulo} — PDF já existe, pulando (REBAIXAR=1 para forçar).`);
          pulados++;
          continue;
        }

        const tipos = linhas.map((l) => l.tipoDebito).filter(Boolean).join(', ');
        console.log(`${rotulo} — baixando (${tipos || 'tipo não informado'})...`);

        const resultado = await baixarBoleto(page, numero, ano, PASTA_BOLETOS);
        sucesso += resultado.boletos.length;
      } catch (erro) {
        if (erro.semBoletoDisponivel) {
          // A tela de Débitos disse que há débito, mas a tela do boleto
          // não trouxe link (ex: pagamento compensado entre uma tela e
          // outra). Estado de negócio, não falha do robô.
          semBoleto++;
          console.log(`${rotulo} — sem link de boleto: ${erro.situacao?.situacaoTarifa || 'sem detalhe'}`);
        } else {
          falha++;
          console.error(`${rotulo} — ERRO: ${erro.message}`);
        }
      }
    }

    console.log(
      `\nFinalizado. Boletos baixados: ${sucesso} | ` +
      `AETs puladas (já tinham PDF): ${pulados} | ` +
      `Sem boleto disponível: ${semBoleto} | Falhas: ${falha}`
    );
  } catch (erro) {
    console.error(`Erro fatal: ${erro.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();