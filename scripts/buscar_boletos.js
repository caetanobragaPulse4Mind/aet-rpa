/**
 * buscar_boletos.js
 *
 * SIAET (DNIT) — Lote de download de boletos, com gravação no Supabase.
 *
 * Descobre quais AETs têm boleto em aberto pela tela
 * FINANCEIRO > Débitos (conDebitoTransportador.asp), chama o
 * baixar_boleto.js para cada uma, comprime o PDF com Ghostscript e
 * registra o boleto na tabela `boletos` com boleto_anexado = true.
 *
 * Espelha a lógica do anexar_aets.js:
 *   - autentica no Supabase via signInWithPassword
 *   - controla o que falta pela flag boleto_anexado
 *   - erro numa AET não interrompe o lote
 *   - separa pendência de negócio (sem boleto disponível) de falha real
 *
 * POR QUE PARTIR DA TELA DE DÉBITOS:
 *   Ela lista as AETs com débito em aberto SEM exigir captcha — é só
 *   navegação de menu. Só se gasta captcha nas AETs que realmente têm
 *   boleto a baixar. Varrer o banco inteiro tentando cada AET
 *   desperdiçaria OCR em massa, e o captcha dessa tela é justamente o
 *   de menor taxa de acerto do sistema.
 *
 * ESTRUTURA DA TELA DE DÉBITOS (confirmada em HTML real):
 *   <table id="tblRelatorioDiario">
 *     cabeçalho: AET Número | Tipo Débito | Data de Vencimento | Valor
 *     dados:     292712/2026 | Tarifa de AET | 23/07/2026 | 91,48
 *     rodapé:    TOTAL (colspan=3) | 91,48
 *
 *   O parser aceita apenas linhas cuja primeira célula bate com
 *   NNNNNN/AAAA — cabeçalho e TOTAL caem fora sozinhos, sem depender
 *   de índice de linha.
 *
 *   ATENÇÃO: o HTML de referência é de transportador SEM débitos
 *   impeditivos. Se houver débito vencido, o SIAET provavelmente
 *   renderiza uma segunda tabela. O seletor usa querySelectorAll, que
 *   captura TODAS as tabelas com esse id (ASP costuma repetir id), então
 *   em tese os dois casos entram no lote — falta confirmar com um HTML
 *   real de transportador com débito vencido.
 *
 * PREMISSA ATUAL: 1 boleto por AET.
 *   Por isso a chave de upsert é o próprio aet_id, e o arquivo se chama
 *   {numero}-{ano}.pdf. Se o SIAET trouxer mais de um link na mesma
 *   tela, o baixar_boleto.js grava os extras com sufixo e este script
 *   avisa no log — aí a premissa precisa ser revista com o cliente.
 *
 * PRÉ-REQUISITOS NO BANCO:
 *   ALTER TABLE boletos DROP COLUMN url;
 *   ALTER TABLE boletos ADD COLUMN boleto_anexado boolean DEFAULT false;
 *   CREATE UNIQUE INDEX boletos_aet_id_key ON boletos (aet_id);
 *
 *   (a flag chama-se boleto_anexado aqui, e nao pdf_anexado como em
 *   `aets`, para deixar explicito de qual artefato se trata)
 *
 * Uso:
 *   node scripts/buscar_boletos.js
 *   LIMITE_TESTE=2 node scripts/buscar_boletos.js
 *   REBAIXAR=1 node scripts/buscar_boletos.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const { fazerLoginCompleto } = require('./siaet_login_completo.js');
const { baixarBoleto } = require('./baixar_boleto.js');

const URL_DEBITOS = 'https://siaet.dnit.gov.br/manutencao/conDebitoTransportador.asp';
const SELETOR_TABELA = 'table#tblRelatorioDiario';
const SELETOR_MENU_DEBITOS = 'a[href*="conDebitoTransportador.asp"]';

const PASTA_BOLETOS = process.env.PASTA_PDFS_BOLETOS || '/app/pdfs/boletos';
const REBAIXAR = process.env.REBAIXAR === '1';
const GS_PRESET = '/ebook';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);

// ---------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------

async function autenticarSupabase() {
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.SUPABASE_AUTH_EMAIL,
    password: process.env.SUPABASE_AUTH_PASSWORD,
  });
  if (error) throw new Error(`Falha ao autenticar no Supabase: ${error.message}`);
}

async function buscarAetPorNumero(numeroAet) {
  const { data, error } = await supabase
    .from('aets')
    .select('id, numero_aet')
    .eq('numero_aet', numeroAet)
    .maybeSingle();

  if (error) throw new Error(`Falha ao consultar AET ${numeroAet}: ${error.message}`);
  return data; // null se não existir
}

async function buscarBoletoDaAet(aetId) {
  const { data, error } = await supabase
    .from('boletos')
    .select('id, boleto_anexado, status')
    .eq('aet_id', aetId)
    .maybeSingle();

  if (error) throw new Error(`Falha ao consultar boleto da AET: ${error.message}`);
  return data;
}

// Upsert usando aet_id como chave de conflito (índice único criado no
// pré-requisito). Assim reexecuções do lote atualizam a linha em vez de
// duplicar — mesmo papel que o numero_aet cumpre na tabela aets.
async function gravarBoleto(aetId, dados) {
  const { error } = await supabase
    .from('boletos')
    .upsert(
      {
        aet_id: aetId,
        valor: dados.valor,
        data_vencimento: dados.dataVencimento,
        boleto_anexado: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'aet_id' }
    );

  if (error) throw new Error(`Falha ao gravar boleto: ${error.message}`);
}

// ---------------------------------------------------------------
// Conversões dos dados da tela (formato BR → formato do banco)
// ---------------------------------------------------------------

// "91,48" → 91.48   |   "1.234,56" → 1234.56
function parseValor(texto) {
  if (!texto) return 0;
  const limpo = String(texto).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const numero = parseFloat(limpo);
  return Number.isFinite(numero) ? numero : 0;
}

// "23/07/2026" → "2026-07-23" (formato date do Postgres)
function parseData(texto) {
  const m = String(texto || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dia, mes, ano] = m;
  return `${ano}-${mes}-${dia}`;
}

function splitNumeroAet(numeroAet) {
  const [numero, ano] = String(numeroAet).split('/');
  if (!numero || !ano) {
    throw new Error(`Formato inesperado de número de AET: "${numeroAet}"`);
  }
  return { numero, ano };
}

// ---------------------------------------------------------------
// Compressão (mesma do anexar_aets.js)
// ---------------------------------------------------------------

async function comprimirPdf(caminhoOriginal) {
  const caminhoTemp = caminhoOriginal.replace(/\.pdf$/, '.tmp.pdf');
  await execFileAsync('gs', [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${GS_PRESET}`,
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    `-sOutputFile=${caminhoTemp}`,
    caminhoOriginal,
  ]);
  fs.renameSync(caminhoTemp, caminhoOriginal);
}

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

async function lerDebitos(page) {
  return page.$$eval(`${SELETOR_TABELA} tr`, (linhas) => {
    const resultado = [];

    for (const linha of linhas) {
      const celulas = Array.from(linha.querySelectorAll('td')).map((td) =>
        (td.innerText || '').replace(/\u00a0/g, ' ').trim()
      );

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

// Uma AET pode aparecer em mais de uma linha (tarifas distintas). Como
// o baixar_boleto.js já pega todos os links da tela numa visita só,
// agrupamos para não gastar dois captchas na mesma página.
function agruparPorAet(debitos) {
  const mapa = new Map();
  for (const d of debitos) {
    if (!mapa.has(d.numeroAet)) mapa.set(d.numeroAet, []);
    mapa.get(d.numeroAet).push(d);
  }
  return mapa;
}

// ---------------------------------------------------------------
// Execução
// ---------------------------------------------------------------

(async () => {
  fs.mkdirSync(PASTA_BOLETOS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  // Contexto explícito: browser.newPage() cria um contexto "próprio"
  // que recusa uma segunda página ("Please use browser.newContext()"),
  // e o download do boleto precisa abrir uma aba extra.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('Autenticando no Supabase...');
    await autenticarSupabase();

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
    let semAet = 0;
    let falha = 0;

    for (let i = 0; i < aets.length; i++) {
      const [numeroAet, linhas] = aets[i];
      const rotulo = `[${i + 1}/${aets.length}] ${numeroAet}`;

      try {
        const { numero, ano } = splitNumeroAet(numeroAet);

        // boletos.aet_id é NOT NULL: sem a AET no banco não há como
        // gravar. Acontece se a tela de Débitos trouxer uma AET que o
        // incrementar_aets.js ainda não sincronizou.
        const aet = await buscarAetPorNumero(numeroAet);
        if (!aet) {
          semAet++;
          console.log(`${rotulo} — AET não encontrada na tabela aets, pulando.`);
          continue;
        }

        if (!REBAIXAR) {
          const boletoExistente = await buscarBoletoDaAet(aet.id);
          if (boletoExistente?.boleto_anexado) {
            pulados++;
            console.log(`${rotulo} — já anexado, pulando (REBAIXAR=1 para forçar).`);
            continue;
          }
        }

        const tipos = linhas.map((l) => l.tipoDebito).filter(Boolean).join(', ');
        console.log(`${rotulo} — baixando (${tipos || 'tipo não informado'})...`);

        const resultado = await baixarBoleto(page, numero, ano, PASTA_BOLETOS);

        if (resultado.boletos.length > 1) {
          // Premissa de 1 boleto por AET violada: os arquivos extras
          // foram gravados em disco, mas a tabela só guarda uma linha
          // por aet_id. Fica registrado para revisão com o cliente.
          console.warn(
            `${rotulo} — ATENÇÃO: ${resultado.boletos.length} boletos nesta AET. ` +
            `Todos os PDFs foram salvos, mas só um registro será gravado no banco.`
          );
        }

        for (const b of resultado.boletos) {
          const antes = fs.statSync(b.caminhoPdf).size;
          await comprimirPdf(b.caminhoPdf);
          const depois = fs.statSync(b.caminhoPdf).size;
          console.log(
            `   ${path.basename(b.caminhoPdf)} — ` +
            `${(antes / 1024).toFixed(0)}KB → ${(depois / 1024).toFixed(0)}KB`
          );
        }

        // Usa a primeira linha de débito como referência de valor e
        // vencimento (com a premissa de 1 boleto, só existe uma).
        await gravarBoleto(aet.id, {
          valor: parseValor(linhas[0].valor),
          dataVencimento: parseData(linhas[0].dataVencimento),
        });

        sucesso++;
        console.log(`${rotulo} — concluído.`);
      } catch (erro) {
        if (erro.semBoletoDisponivel) {
          // A tela de Débitos indicou débito, mas a tela do boleto não
          // trouxe link (ex: pagamento compensado entre uma tela e
          // outra). Estado de negócio, não falha do robô.
          semBoleto++;
          console.log(
            `${rotulo} — sem link de boleto: ` +
            `${erro.situacao?.situacaoTarifa || 'sem detalhe'}`
          );
        } else {
          falha++;
          console.error(`${rotulo} — ERRO: ${erro.message}`);
        }
      }
    }

    console.log(
      `\nFinalizado. Sucesso: ${sucesso} | Já anexados: ${pulados} | ` +
      `Sem boleto disponível: ${semBoleto} | AET fora do banco: ${semAet} | ` +
      `Falhas: ${falha}`
    );
  } catch (erro) {
    console.error(`Erro fatal: ${erro.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();