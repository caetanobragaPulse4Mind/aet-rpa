/**
 * incrementar_aets.js — Incremento diário/sob-demanda da tabela `aets` (Supabase)
 *
 * Diferença em relação a popular_aets.js (backfill dos últimos 12 meses):
 *   Este script NÃO varre 12 meses. Ele:
 *     1. Consulta o Supabase pra descobrir o MAIOR numero_aet já salvo
 *        dentro do ANO ATUAL (numero_aet vem do site no formato
 *        "NNNNNN/AAAA", ex: "282830/2026").
 *     2. Busca no SIAET somente o MÊS ATUAL (não o histórico todo).
 *     3. Do resultado, filtra e salva apenas as AETs cujo número seja
 *        MAIOR que o último já salvo — ou seja, só o que é novo desde
 *        a última execução.
 *
 * Isso evita reprocessar o mês inteiro a cada rodada e deixa o script
 * seguro pra rodar em cron/loop periódico.
 *
 * NOTA: este script apenas POPULA a tabela `aets` (busca + upsert).
 * A anexação de PDF (anexar_aets.js) foi removida daqui de propósito —
 * roda separadamente, em outra rotina/agendamento.
 *
 * Reaproveita a mesma navegação por menu real (Referer válido) e o
 * login de siaet_login_completo.js já usados em popular_aets.js — ver
 * comentários lá para o porquê de não usar page.goto() direto.
 *
 * Pré-requisitos: os mesmos de popular_aets.js — este arquivo precisa
 * ficar na mesma pasta de siaet_login_completo.js, captcha_ocr.js e
 * captcha_playwright.js (ex: scripts/incrementar_aets.js dentro do
 * repo aet-rpa).
 *
 * .env necessário (igual popular_aets.js):
 *   SUPABASE_URL=...
 *   SUPABASE_PUBLISHABLE_KEY=...
 *   SUPABASE_AUTH_EMAIL=<email de um usuário existente em profiles>
 *   SUPABASE_AUTH_PASSWORD=<senha desse usuário>
 *   SIAET_CODIGO_ACESSO / demais vars exigidas por siaet_login_completo.js
 *
 * Requer a mesma constraint UNIQUE já usada no backfill:
 *   ALTER TABLE aets ADD CONSTRAINT aets_numero_aet_key UNIQUE (numero_aet);
 */

require('dotenv').config();

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');

// Mesmo padrão de pastas do anexar_aets.js — a Hetzner não tem tela,
// então tudo que seria "olhar ao vivo" precisa virar arquivo no volume
// persistente (aet-rpa_aet-rpa-pdfs, montado em /app/pdfs) pra
// sobreviver a restart/redeploy do container e dar pra consultar via
// Termius depois.
const PASTA_LOGS = process.env.PASTA_LOGS_AETS || './logs/execucao-incremento-aets';
const PASTA_SCREENSHOTS = process.env.PASTA_SCREENSHOTS_AETS || './logs/screenshots-incremento-aets';

// Arquivo único acumulando todas as rodadas (append). No Hetzner,
// PASTA_LOGS aponta pro volume persistente (/app/pdfs/...) via env no
// compose, então este arquivo sobrevive a restart/redeploy e pode ser
// consultado depois via Termius.
const ARQUIVO_LOG = path.join(PASTA_LOGS, 'incremento-aets.log');

// Pasta onde cada rodada grava um arquivo NOVO (com timestamp no nome)
// listando os numero_aet inseridos nessa rodada — um por linha. É esse
// arquivo que o script de anexação de PDF vai consumir pra saber
// exatamente quais AETs processar, em vez de varrer o banco todo.
// No Hetzner, aponta pro volume persistente via env no compose.
const PASTA_AETS_NOVAS =
  process.env.PASTA_AETS_NOVAS || './logs/aets-novas';

// ---------------------------------------------------------------
// Logger — espelha tudo que vai pro console também no arquivo de log
// acumulado. Escreve com fs.appendFileSync (síncrono) pra garantir
// que cada linha seja gravada na hora, mesmo se o processo morrer no
// meio. streamLog fica aberto durante a execução; iniciarLog escreve
// um cabeçalho com timestamp pra separar visualmente as rodadas
// dentro do arquivo acumulado.
// ---------------------------------------------------------------

function log(mensagem) {
  console.log(mensagem);
  try {
    fs.appendFileSync(ARQUIVO_LOG, mensagem + '\n');
  } catch (e) {
    // Se falhar a gravação em disco, não derruba a execução — o
    // console.log acima já garante visibilidade mínima.
    console.error(`(aviso: não foi possível gravar no log em disco: ${e.message})`);
  }
}

function logErro(mensagem) {
  console.error(mensagem);
  try {
    fs.appendFileSync(ARQUIVO_LOG, mensagem + '\n');
  } catch (e) {
    console.error(`(aviso: não foi possível gravar no log em disco: ${e.message})`);
  }
}

function iniciarLog() {
  const cabecalho =
    `\n===== Execução iniciada em ${new Date().toISOString()} =====`;
  log(cabecalho);
}

// ---------------------------------------------------------------
// Valida, logo no início (fail-fast), se dá pra escrever de fato no
// volume de log — ANTES de abrir o navegador e mexer no Supabase.
// Assim, se o volume não estiver montado/acessível (ex: PASTA_LOGS
// apontando pra fora do volume persistente, ou sem permissão), o
// script falha na largada com mensagem clara, em vez de fazer todo o
// trabalho pesado e só depois descobrir que o log não persistiu.
//
// Faz um teste real de escrita (cria a pasta, grava e apaga um
// arquivo temporário) porque só checar existência da pasta não
// garante permissão de escrita.
// ---------------------------------------------------------------

function validarEscritaLog() {
  try {
    fs.mkdirSync(PASTA_LOGS, { recursive: true });
    const arquivoTeste = path.join(PASTA_LOGS, `.write-test-${process.pid}`);
    fs.writeFileSync(arquivoTeste, 'ok');
    fs.unlinkSync(arquivoTeste);
  } catch (e) {
    throw new Error(
      `Não foi possível gravar no diretório de log "${PASTA_LOGS}" ` +
      `(${e.message}). Confira se PASTA_LOGS_AETS aponta pra dentro do ` +
      `volume persistente montado no container e se há permissão de ` +
      `escrita. O script foi abortado antes de buscar/salvar qualquer AET.`
    );
  }
}

// ---------------------------------------------------------------
// Grava um arquivo NOVO por rodada (timestamp no nome) listando os
// numero_aet inseridos nessa rodada — um por linha, texto puro. É o
// "recado" que o script de anexação de PDF consome pra saber quais
// AETs processar, sem varrer o banco inteiro.
//
// Sempre gera o arquivo, mesmo sem AETs novas (fica vazio) — assim o
// consumidor sempre encontra um arquivo correspondente à execução e
// não fica em dúvida se a rodada aconteceu ou não.
//
// Retorna o caminho do arquivo gerado (pra logar).
// ---------------------------------------------------------------

function gravarArquivoAetsNovas(numeros) {
  fs.mkdirSync(PASTA_AETS_NOVAS, { recursive: true });

  // Nome com timestamp ISO (sanitizado pra ser válido em filesystem):
  // aets-novas-2026-07-21T21-54-56-106Z.txt
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const caminho = path.join(PASTA_AETS_NOVAS, `aets-novas-${carimbo}.txt`);

  // Um numero_aet por linha. Se não houve nenhuma, grava arquivo vazio.
  const conteudo = numeros.length > 0 ? numeros.join('\n') + '\n' : '';
  fs.writeFileSync(caminho, conteudo);

  return caminho;
}

// ---------------------------------------------------------------
// Cliente Supabase — mesma lógica de auth de popular_aets.js: sem
// service role key (Lovable Cloud), então autentica via
// signInWithPassword() com um usuário já cadastrado em profiles; a
// policy aets_all (ALL, authenticated, using true) libera o resto.
// ---------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PUBLISHABLE_KEY
);

async function autenticarSupabase() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env.SUPABASE_AUTH_EMAIL,
    password: process.env.SUPABASE_AUTH_PASSWORD,
  });

  if (error) {
    throw new Error(
      `Falha ao autenticar no Supabase (${error.message}). Confira ` +
      `SUPABASE_AUTH_EMAIL e SUPABASE_AUTH_PASSWORD no .env — precisa ` +
      `ser um usuário já cadastrado em profiles.`
    );
  }

  log(`Autenticado no Supabase como ${data.user.email}.`);
}

// ---------------------------------------------------------------
// numero_aet vem do SIAET no formato "NNNNNN/AAAA" (ex: "282830/2026").
// Esta função separa número e ano; retorna null se não bater o padrão
// (proteção contra célula vazia/formatada diferente).
// ---------------------------------------------------------------

function extrairNumeroEAno(numeroAet) {
  const match = String(numeroAet || '').trim().match(/^(\d+)\/(\d{4})$/);
  if (!match) return null;
  return { numero: parseInt(match[1], 10), ano: parseInt(match[2], 10) };
}

// ---------------------------------------------------------------
// Busca no Supabase o maior número de AET já salvo dentro do ano
// informado. Como numero_aet é texto, não dá pra confiar em MAX()
// direto (ordenação de string, não numérica) — por isso trazemos
// todas as AETs do ano via filtro `like '%/ANO'` e calculamos o
// maior número em JS.
// ---------------------------------------------------------------

async function buscarUltimoNumeroDoAno(ano) {
  const { data, error } = await comTimeout(
    supabase.from('aets').select('numero_aet').like('numero_aet', `%/${ano}`),
    15000,
    'Timeout de 15s buscando o último numero_aet no Supabase — possível ' +
    'problema de rede/DNS/firewall, ou a sessão de auth expirou.'
  );

  if (error) {
    throw new Error(`Erro ao consultar último numero_aet no Supabase: ${error.message}`);
  }

  let maior = 0;
  for (const row of data || []) {
    const parsed = extrairNumeroEAno(row.numero_aet);
    if (parsed && parsed.ano === ano && parsed.numero > maior) {
      maior = parsed.numero;
    }
  }

  return maior;
}

// ---------------------------------------------------------------
// Entra na listagem de AETs pelo caminho real do site — idêntico a
// popular_aets.js. Ver comentário lá para o porquê de não usar
// page.goto() direto (falta do header Referer).
// ---------------------------------------------------------------

async function navegarParaListagem(page) {
  await page.getByText('TRANSPORTADOR', { exact: true }).click();
  await page.getByText('Listar AET', { exact: true }).click();
  await page.waitForSelector('select[name="cboResolucao"]');
}

function parseDataBr(dataStr) {
  if (!dataStr) return null;
  const match = dataStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dia, mes, ano] = match;
  return `${ano}-${mes}-${dia}`;
}

async function extrairLinhasDaTabela(page) {
  const linhas = await page.$$eval('table[border="1"] tbody tr', (trs) =>
    trs.slice(1).map((tr) => {
      const tds = tr.querySelectorAll('td');
      const texto = (i) => tds[i]?.innerText.replace(/\u00A0/g, '').trim() || '';
      return {
        numero_aet: texto(0),
        resolucao: texto(1),
        data_aet: texto(2),
        origem_carga: texto(3),
        destino_carga: texto(4),
        situacao: texto(5),
        data_vencimento: texto(6),
      };
    })
  );

  return linhas.filter((l) => l.numero_aet);
}

// ---------------------------------------------------------------
// Busca o mês/ano atual e devolve os registros já no formato da
// tabela `aets` — idêntico ao buscarMes de popular_aets.js, sem o
// filtro por número ainda (isso acontece depois, em relação ao
// último número salvo).
// ---------------------------------------------------------------

async function buscarMesAtual(page, ano, mes) {
  log(`Buscando AETs de ${String(mes).padStart(2, '0')}/${ano}...`);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.evaluate(
      ({ ano, mes }) => {
        document.Formulario.cboSituacaoAet.value = 'ALL';
        document.Formulario.cboAno.value = String(ano);
        document.Formulario.cboMes.value = String(mes);
        document.Formulario.cboResolucao.value = '25';
        btnActionClick();
      },
      { ano, mes }
    ),
  ]);

  const resultado = await Promise.race([
    page
      .waitForSelector('table[border="1"]', { timeout: 15000 })
      .then(() => 'tabela'),
    page
      .waitForSelector('input#securityCode', { timeout: 15000 })
      .then(() => 'sessao_expirada'),
  ]).catch(() => 'nenhum');

  if (resultado === 'sessao_expirada') {
    throw new Error(
      `Sessão expirou ao buscar ${mes}/${ano} — o SIAET redirecionou de ` +
      `volta pra tela de login em vez de mostrar a listagem.`
    );
  }

  if (resultado === 'nenhum') {
    await page.screenshot({ path: `erro-sessao-incremento-${ano}-${mes}.png` });
    throw new Error(
      `Nem a tabela de resultados nem a tela de login apareceram em 15s ` +
      `ao buscar ${mes}/${ano}. Screenshot salvo em ` +
      `erro-sessao-incremento-${ano}-${mes}.png.`
    );
  }

  const linhasBrutas = await extrairLinhasDaTabela(page);
  log(`  ${linhasBrutas.length} AET(s) encontrada(s) no mês.`);

  return linhasBrutas.map((l) => ({
    numero_aet: l.numero_aet,
    resolucao: l.resolucao || null,
    origem_carga: l.origem_carga || null,
    destino_carga: l.destino_carga || null,
    situacao: l.situacao || null,
    portal_origem: 'SIAET',
    data_inicio: parseDataBr(l.data_aet),
    data_fim: parseDataBr(l.data_vencimento),
  }));
}

// ---------------------------------------------------------------
// Filtra apenas os registros com numero_aet maior que o último já
// salvo no ano — é isso que transforma a varredura do mês inteiro
// num incremento de fato.
// ---------------------------------------------------------------

function filtrarNovos(registros, ano, ultimoNumero) {
  return registros.filter((r) => {
    const parsed = extrairNumeroEAno(r.numero_aet);
    if (!parsed) return false; // numero_aet fora do padrão esperado — ignora
    if (parsed.ano !== ano) return false; // segurança extra, não deveria ocorrer no mês atual
    return parsed.numero > ultimoNumero;
  });
}

function comTimeout(promessa, ms, mensagemErro) {
  return Promise.race([
    promessa,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(mensagemErro)), ms)
    ),
  ]);
}

async function salvarNoSupabase(registros) {
  if (registros.length === 0) return [];

  log(`  Salvando ${registros.length} registro(s) novo(s) no Supabase...`);

  // .select('id, numero_aet') no upsert devolve as linhas gravadas.
  const { data, error } = await comTimeout(
    supabase
      .from('aets')
      .upsert(registros, { onConflict: 'numero_aet' })
      .select('id, numero_aet'),
    15000,
    'Timeout de 15s esperando resposta do Supabase — possível problema ' +
    'de rede/DNS/firewall bloqueando o host do Supabase, ou a sessão de ' +
    'auth expirou.'
  );

  if (error) {
    logErro(`  Erro ao salvar no Supabase: ${error.message}`);
    throw error;
  }

  log('  Salvo.');
  return data || [];
}

// ---------------------------------------------------------------
// EXECUÇÃO
// ---------------------------------------------------------------

(async () => {
  // Fail-fast: valida escrita no volume de log ANTES de qualquer
  // trabalho pesado. Se não der pra gravar (volume não montado, sem
  // permissão, caminho fora do volume), aborta aqui com mensagem clara
  // e código de saída 1 — sem abrir navegador nem tocar no Supabase.
  try {
    validarEscritaLog();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  fs.mkdirSync(PASTA_SCREENSHOTS, { recursive: true });

  // Cabeçalho com timestamp pra separar esta rodada das anteriores
  // dentro do arquivo de log acumulado.
  iniciarLog();

  // headless: true — obrigatório na Hetzner, que não tem display.
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await autenticarSupabase();

    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    const mesAtual = hoje.getMonth() + 1;

    const ultimoNumero = await buscarUltimoNumeroDoAno(anoAtual);
    log(
      ultimoNumero > 0
        ? `Última AET salva no ano ${anoAtual}: ${ultimoNumero}. Buscando números maiores que esse.`
        : `Nenhuma AET salva ainda no ano ${anoAtual}. Todas as encontradas no mês serão salvas.`
    );

    await fazerLoginCompleto(page);
    log('Login concluído.');

    await navegarParaListagem(page);
    log(`Entrou na listagem de AETs — buscando somente ${String(mesAtual).padStart(2, '0')}/${anoAtual}.\n`);

    const registrosDoMes = await buscarMesAtual(page, anoAtual, mesAtual);
    const registrosNovos = filtrarNovos(registrosDoMes, anoAtual, ultimoNumero);

    log(
      `  ${registrosNovos.length} de ${registrosDoMes.length} são novos (numero_aet > ${ultimoNumero}).`
    );

    const registrosSalvos = await salvarNoSupabase(registrosNovos);

    log(`\nConcluído. ${registrosNovos.length} AET(s) nova(s) inserida(s)/atualizada(s).`);

    // Números das AETs salvas nesta rodada — vai pra tela e pro
    // arquivo de log acumulado, pra dar visibilidade rápida do que
    // entrou sem precisar ir no Supabase conferir.
    const numerosSalvos = registrosSalvos.map((r) => r.numero_aet);
    if (numerosSalvos.length > 0) {
      log(`Números das AETs salvas: ${numerosSalvos.join(', ')}`);
    }

    // Arquivo da rodada (um numero_aet por linha) pro script de
    // anexação consumir. Sempre gerado, mesmo vazio.
    const caminhoAetsNovas = gravarArquivoAetsNovas(numerosSalvos);
    log(
      numerosSalvos.length > 0
        ? `Arquivo com ${numerosSalvos.length} AET(s) nova(s) gravado em: ${caminhoAetsNovas}`
        : `Nenhuma AET nova nesta rodada — arquivo vazio gravado em: ${caminhoAetsNovas}`
    );
  } catch (erro) {
    logErro(`Falha no script: ${erro.message}`);
    // Salvo no volume persistente (não na raiz do container) — sem
    // isso o print some no próximo redeploy/restart.
    const nomeArquivo = `erro-incrementar-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const caminhoScreenshot = path.join(PASTA_SCREENSHOTS, nomeArquivo);
    try {
      await page.screenshot({ path: caminhoScreenshot });
      logErro(`Screenshot da falha salvo em: ${caminhoScreenshot}`);
    } catch (erroScreenshot) {
      logErro(`Não foi possível salvar screenshot: ${erroScreenshot.message}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
})();