/**
 * anexar_aets.js
 *
 * Roda de dois jeitos:
 *
 *   A) Standalone (docker exec ... node scripts/anexar_aets.js):
 *      abre o próprio browser headless, faz login no SIAET e processa
 *      todas as AETs com pdf_anexado = false/null. Comportamento igual
 *      ao de sempre — o bloco `if (require.main === module)` no fim
 *      cuida disso.
 *
 *   B) Importado por outro script (ex: incrementar_aets.js):
 *      exporta `anexarPendentes(page)`, que recebe uma page JÁ logada
 *      no SIAET e só faz o trabalho — não abre browser nem loga de
 *      novo. Assim o incrementar reaproveita a sessão que já tem em
 *      mãos depois de sincronizar as AETs novas.
 *
 * O que ele faz em ambos os casos:
 *   1. Autentica no Supabase (signInWithPassword — mesmo padrão de popular_aets.js)
 *   2. Busca em `aets` os registros com pdf_anexado = false/null
 *      (ou usa a lista de registros passada pelo chamador)
 *   3. Para cada AET pendente: gera o PDF (imprimirAet), comprime com
 *      Ghostscript (/ebook) e salva em /app/pdfs/aets/{numero}-{ano}.pdf
 *   4. Marca pdf_anexado = true no Supabase
 *   5. Erro numa AET não interrompe o lote — loga e segue pra próxima
 *
 * Pré-requisitos:
 *   - Coluna `pdf_anexado` (boolean) na tabela `aets`:
 *       ALTER TABLE aets ADD COLUMN pdf_anexado boolean DEFAULT false;
 *   - Ghostscript instalado na imagem (apt-get install -y ghostscript)
 *   - Volume aet-rpa-pdfs montado em /app/pdfs
 *   - imprimir_aet.js, siaet_login_completo.js, captcha_playwright.js
 *     na mesma pasta scripts/
 *
 * Execução standalone (dentro do container em produção):
 *   docker exec -it $(docker ps -qf "name=aet-rpa_aet-rpa") node scripts/anexar_aets.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const { imprimirAet } = require('./imprimir_aet.js');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');

const PASTA_PDFS = process.env.PASTA_PDFS_AETS || '/app/pdfs/aets';
const PASTA_LOGS = process.env.PASTA_LOGS_AETS || '/app/pdfs/logs';
const PASTA_SCREENSHOTS = process.env.PASTA_SCREENSHOTS_AETS || '/app/pdfs/logs/screenshots';
const GS_PRESET = '/ebook';

// ---------------------------------------------------------------
// Log em arquivo (além do console) — cada execução gera um arquivo
// novo com timestamp, pra sobreviver a quedas de conexão SSH e dar
// histórico entre execuções (já que o lote precisa rodar mais de
// uma vez por causa do limite de 1000 linhas por consulta do
// Supabase).
// ---------------------------------------------------------------

const timestampExecucao = new Date().toISOString().replace(/[:.]/g, '-');
let streamLog = null;

function log(...args) {
  const linha = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(linha);
  if (streamLog) streamLog.write(linha + '\n');
}

function logErro(...args) {
  const linha = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.error(linha);
  if (streamLog) streamLog.write(linha + '\n');
}

// Cria as pastas e abre o stream de log. Idempotente: pode ser
// chamada tanto pelo bloco standalone quanto pelo anexarPendentes
// sem risco de reabrir o stream (guarda em `if (!streamLog)`).
function inicializarLog() {
  fs.mkdirSync(PASTA_PDFS, { recursive: true });
  fs.mkdirSync(PASTA_LOGS, { recursive: true });
  fs.mkdirSync(PASTA_SCREENSHOTS, { recursive: true });
  if (!streamLog) {
    streamLog = fs.createWriteStream(
      path.join(PASTA_LOGS, `execucao-${timestampExecucao}.log`),
      { flags: 'a' }
    );
  }
}

// Fecha o stream de log. O chamador (standalone ou incrementar_aets)
// chama isso no finally pra garantir o flush do arquivo.
function finalizarLog() {
  if (streamLog) {
    streamLog.end();
    streamLog = null;
  }
}

// Falhas registradas separadamente em JSON, pra consultar depois
// quais AETs precisam de atenção manual sem caçar no meio do log
// inteiro.
const falhasRegistradas = [];

// Alguns erros técnicos do imprimir_aet.js correspondem a situações
// conhecidas do SIAET, não a bugs — aqui a gente traduz pra uma
// mensagem que já diz o que fazer, mantendo o erro técnico original
// junto (campo erro_original) pra depuração futura.
function classificarErro(erro) {
  // Quando o imprimir_aet.js já extraiu a situação da própria página
  // (ver extrair_situacao_pagina.js), usa o texto real do SIAET em vez
  // de tentar adivinhar pelo padrão da URL/mensagem técnica.
  if (erro.situacao && erro.situacao.situacaoAet) {
    return erro.situacao.situacaoAet;
  }

  const msg = erro.message || '';

  if (msg.includes('manProprietarioCarga')) {
    return 'Faltam informações do proprietário da carga (nota fiscal/DAMDFE) — precisa ser preenchido no SIAET antes de imprimir.';
  }
  if (msg.includes('page.goto') && msg.includes('Timeout')) {
    return 'Erro ao baixar, tente novamente (timeout de rede ao carregar o SIAET).';
  }
  if (msg.includes('CANCELADA')) {
    return 'AET cancelada no SIAET — não há PDF para baixar.';
  }
  return msg;
}

function registrarFalha(numeroAet, erro, caminhoScreenshot) {
  falhasRegistradas.push({
    numero_aet: numeroAet,
    erro: classificarErro(erro),
    erro_original: erro.message,
    situacao_registrada: Boolean(erro.situacao),
    screenshot: caminhoScreenshot || null,
    timestamp: new Date().toISOString(),
  });
}

function salvarFalhasEmArquivo() {
  if (falhasRegistradas.length === 0) return;
  const caminho = path.join(PASTA_LOGS, `falhas-${timestampExecucao}.json`);
  fs.writeFileSync(caminho, JSON.stringify(falhasRegistradas, null, 2));
  log(`${falhasRegistradas.length} falha(s) registrada(s) em ${caminho}`);
}

// Captura um print da tela no momento da falha — útil pra casos como
// telas inesperadas do SIAET (ex: manProprietarioCarga.asp) que não
// se encaixam nos dois cenários já mapeados (sucesso / captcha
// errado). Nunca deixa o erro do screenshot mascarar o erro original.
async function capturarScreenshotFalha(page, numeroAet) {
  const nomeArquivo = `${numeroAet.replace('/', '-')}-${Date.now()}.png`;
  const caminho = path.join(PASTA_SCREENSHOTS, nomeArquivo);
  try {
    await page.screenshot({ path: caminho, fullPage: true });
    log(`  Screenshot da falha salvo em: ${caminho}`);
    return caminho;
  } catch (erroScreenshot) {
    logErro(`  Não foi possível salvar screenshot: ${erroScreenshot.message}`);
    return null;
  }
}
// GS_PRESET: /screen (mais agressivo) | /ebook (equilíbrio) | /printer (qualidade)

// Variável unificada com o incrementar_aets.js — os dois scripts agora
// leem SUPABASE_PUBLISHABLE_KEY (antes este aqui usava SUPABASE_KEY).
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

async function buscarAetsPendentes() {
  const { data, error } = await supabase
    .from('aets')
    .select('id, numero_aet')
    .or('pdf_anexado.is.null,pdf_anexado.eq.false');

  if (error) throw new Error(`Falha ao consultar AETs pendentes: ${error.message}`);
  return data;
}

// Busca uma AET específica por numero_aet exato (ex: "288445/2026") —
// usado no modo standalone quando se quer reprocessar SÓ uma AET (ex:
// depois de corrigir manualmente uma pendência no SIAET), sem esperar
// ela reaparecer no próximo incrementar_aets.js nem rodar o lote
// completo de todas as pendentes.
async function buscarAetPorNumeroExato(numeroAet) {
  const { data, error } = await supabase
    .from('aets')
    .select('id, numero_aet')
    .eq('numero_aet', numeroAet)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar AET ${numeroAet}: ${error.message}`);
  if (!data) throw new Error(`AET ${numeroAet} não encontrada na tabela aets.`);
  return data;
}

async function marcarAnexado(id) {
  const { error } = await supabase.from('aets').update({ pdf_anexado: true }).eq('id', id);
  if (error) throw new Error(`Falha ao atualizar pdf_anexado: ${error.message}`);
}

// Grava o histórico de situação quando o imprimir_aet.js consegue
// extrair os dados da tela (AET devolvida para correção, etc — ver
// extrair_situacao_pagina.js). Nunca deixa uma falha de gravação
// mascarar o erro original que já está sendo tratado no chamador.
//
// Antes de inserir, compara com o último registro dessa AET: como o
// script reprocessa as mesmas AETs pendentes a cada execução (elas
// continuam pdf_anexado=false até serem corrigidas no SIAET), sem
// essa checagem cada execução criaria uma linha idêntica no
// histórico, mesmo sem nada ter mudado.
async function situacaoMudou(aetId, situacaoNova) {
  const { data, error } = await supabase
    .from('aet_situacoes')
    .select('tipo_pendencia, situacao_tarifa, situacao_aet, observacao_analise')
    .eq('aet_id', aetId)
    .order('data_consulta', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // Se a checagem falhar por algum motivo, não bloqueia a gravação
    // — prefere um possível duplicado a perder o registro.
    logErro(`  Falha ao checar histórico de aet_situacoes: ${error.message}`);
    return true;
  }

  if (!data) return true; // nunca registrado antes

  return (
    data.tipo_pendencia !== situacaoNova.tipoPendencia ||
    data.situacao_tarifa !== situacaoNova.situacaoTarifa ||
    data.situacao_aet !== situacaoNova.situacaoAet ||
    data.observacao_analise !== situacaoNova.observacaoAnalise
  );
}

async function registrarSituacaoAet(registro, situacao) {
  const mudou = await situacaoMudou(registro.id, situacao);
  if (!mudou) {
    log(`[${registro.numero_aet}] situação igual à última registrada — não duplicando em aet_situacoes.`);
    return;
  }

  const { error } = await supabase.from('aet_situacoes').insert({
    aet_id: registro.id,
    numero_aet: registro.numero_aet,
    tipo_pendencia: situacao.tipoPendencia,
    situacao_tarifa: situacao.situacaoTarifa,
    situacao_aet: situacao.situacaoAet,
    observacao_analise: situacao.observacaoAnalise,
  });

  if (error) {
    logErro(`[${registro.numero_aet}] Falha ao gravar em aet_situacoes: ${error.message}`);
    return;
  }
  log(`[${registro.numero_aet}] situação registrada em aet_situacoes.`);
}

// ---------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------

// numero_aet vem no formato "229767/2026" — separa número e ano
// pra bater com a assinatura de buscarAetPorNumero(page, numero, ano)
function splitNumeroAet(numeroAet) {
  const [numero, ano] = String(numeroAet).split('/');
  if (!numero || !ano) {
    throw new Error(`Formato inesperado de numero_aet: "${numeroAet}" (esperado "NUMERO/ANO")`);
  }
  return { numero, ano };
}

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
// Processamento de uma AET
// ---------------------------------------------------------------

function formatarDuracao(ms) {
  const totalSegundos = Math.round(ms / 1000);
  const horas = Math.floor(totalSegundos / 3600);
  const minutos = Math.floor((totalSegundos % 3600) / 60);
  const segundos = totalSegundos % 60;

  if (horas > 0) return `${horas}h${minutos}m`;
  if (minutos > 0) return `${minutos}m${segundos}s`;
  return `${segundos}s`;
}

async function processarAet(page, registro) {
  const { numero, ano } = splitNumeroAet(registro.numero_aet);
  const nomeArquivo = `${numero}-${ano}.pdf`;
  const caminhoPdf = path.join(PASTA_PDFS, nomeArquivo);

  log(`[${registro.numero_aet}] gerando PDF...`);
  await imprimirAet(page, numero, ano, caminhoPdf);

  const tamanhoAntes = fs.statSync(caminhoPdf).size;
  log(`[${registro.numero_aet}] comprimindo (${(tamanhoAntes / 1024 / 1024).toFixed(2)}MB)...`);
  await comprimirPdf(caminhoPdf);
  const tamanhoDepois = fs.statSync(caminhoPdf).size;
  log(`[${registro.numero_aet}] comprimido para ${(tamanhoDepois / 1024 / 1024).toFixed(2)}MB`);

  await marcarAnexado(registro.id);
  log(`[${registro.numero_aet}] concluído.`);
}

// ---------------------------------------------------------------
// Núcleo reutilizável
//
// Recebe uma `page` JÁ logada no SIAET. NÃO abre browser nem faz
// login — quem chama cuida disso (o bloco standalone lá embaixo, ou
// o incrementar_aets.js que reaproveita a própria sessão).
//
// Opções:
//   registros: lista [{ id, numero_aet }] pra processar. Se null
//              (padrão), busca todas as AETs pendentes no Supabase.
//              O incrementar pode passar só as AETs novas da rodada.
//
// Retorna { sucesso, pendencia, falha } pro chamador logar/decidir.
// ---------------------------------------------------------------

async function anexarPendentes(page, { registros = null } = {}) {
  await inicializarLog();

  log('Autenticando no Supabase...');
  await autenticarSupabase();

  let pendentes;
  if (registros) {
    pendentes = registros;
    log(`${pendentes.length} AET(s) recebida(s) do chamador para anexação.`);
  } else {
    log('Buscando AETs pendentes de anexação...');
    pendentes = await buscarAetsPendentes();
    log(`${pendentes.length} AET(s) pendente(s) (limitado a 1000 por página da API — pode haver mais).`);
  }

  // LIMITE_TESTE=N roda só os N primeiros pendentes — útil pra validar
  // visualmente o resultado (PDF gerado + compressão) antes de soltar
  // o script contra o lote completo. Ex: LIMITE_TESTE=2 node scripts/anexar_aets.js
  const limiteTeste = parseInt(process.env.LIMITE_TESTE, 10);
  if (Number.isInteger(limiteTeste) && limiteTeste > 0) {
    log(`LIMITE_TESTE ativo — processando só ${limiteTeste} de ${pendentes.length}.`);
    pendentes = pendentes.slice(0, limiteTeste);
  }

  if (pendentes.length === 0) {
    log('Nada a fazer.');
    return { sucesso: 0, pendencia: 0, falha: 0 };
  }

  let sucesso = 0;
  let pendencia = 0;
  let falha = 0;

  const total = pendentes.length;
  const inicioLote = Date.now();

  for (let i = 0; i < total; i++) {
    const registro = pendentes[i];
    const numeroProcessado = i + 1;

    try {
      await processarAet(page, registro);
      sucesso++;
    } catch (erro) {
      if (erro.situacao) {
        // Pendência de negócio conhecida (AET cancelada, devolvida,
        // proprietário da carga pendente, em digitação, etc) — não
        // é uma falha do script, e sim um estado real do SIAET que
        // já foi extraído e registrado em aet_situacoes. Não conta
        // como falha, e não precisa de screenshot (já temos o dado
        // estruturado, tirar print só custaria tempo à toa).
        pendencia++;
        log(`[${registro.numero_aet}] PENDÊNCIA: ${classificarErro(erro)}`);
        await registrarSituacaoAet(registro, erro.situacao);
      } else {
        // Falha técnica real (timeout de rede, captcha esgotado,
        // tela não mapeada) — essas sim precisam de investigação.
        falha++;
        logErro(`[${registro.numero_aet}] ERRO: ${classificarErro(erro)}`);
        const caminhoScreenshot = await capturarScreenshotFalha(page, registro.numero_aet);
        registrarFalha(registro.numero_aet, erro, caminhoScreenshot);
      }
    }

    // Progresso + estimativa de tempo restante, baseado no tempo
    // médio por AET até agora (varia bastante por causa do OCR do
    // captcha, então é uma média corrida, não um valor fixo)
    const decorridoMs = Date.now() - inicioLote;
    const mediaPorAetMs = decorridoMs / numeroProcessado;
    const restantes = total - numeroProcessado;
    const etaMs = restantes * mediaPorAetMs;

    log(
      `Progresso: ${numeroProcessado}/${total} ` +
      `(${sucesso} ok, ${pendencia} pendência, ${falha} falha) — ` +
      `decorrido: ${formatarDuracao(decorridoMs)} — ` +
      `ETA: ${formatarDuracao(etaMs)}`
    );
  }

  log(`Finalizado. Sucesso: ${sucesso} | Pendências conhecidas: ${pendencia} | Falhas reais: ${falha}`);
  salvarFalhasEmArquivo();

  return { sucesso, pendencia, falha };
}

// ---------------------------------------------------------------
// Execução standalone (docker exec ... node scripts/anexar_aets.js).
//
// Quando o arquivo é apenas importado (ex: incrementar_aets.js chama
// anexarPendentes reaproveitando a sessão já logada), este bloco NÃO
// roda — require.main !== module.
// ---------------------------------------------------------------

if (require.main === module) {
  (async () => {
    await inicializarLog();

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      log('Autenticando no Supabase...');
      await autenticarSupabase();

      // NUMERO_AET='288445/2026' node scripts/anexar_aets.js — roda a
      // anexação só pra essa AET específica (ex: depois de corrigir uma
      // pendência manualmente no SIAET), em vez de varrer todas as
      // pendentes do banco.
      let opcoes = {};
      const numeroAlvo = process.env.NUMERO_AET;
      if (numeroAlvo) {
        const registro = await buscarAetPorNumeroExato(numeroAlvo);
        opcoes = { registros: [registro] };
        log(`NUMERO_AET ativo — processando só a AET ${numeroAlvo} (id=${registro.id}).`);
      }

      log('Fazendo login no SIAET...');
      await fazerLoginCompleto(page);
      log('Login concluído.');

      await anexarPendentes(page, opcoes);
    } catch (erro) {
      logErro(`Erro fatal na execução standalone: ${erro.message}`);
    } finally {
      await browser.close();
      finalizarLog();
    }
  })();
}

module.exports = { anexarPendentes, finalizarLog };