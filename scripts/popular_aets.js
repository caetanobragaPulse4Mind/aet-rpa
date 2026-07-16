/**
 * popular_aets.js — Backfill histórico da tabela `aets` (Supabase)
 *
 * Reaproveita o login já validado em siaet_login_completo.js, entra
 * na listagem de AETs pelo caminho real do site (menu TRANSPORTADOR
 * > Listar AET) e, pra cada um dos últimos 12 meses, preenche os
 * filtros e aciona a busca exatamente como um clique manual faria.
 *
 * IMPORTANTE — por que não usar page.goto() direto numa URL?
 *   A URL de listagem é conhecida (conAetTransportador.asp com os
 *   parâmetros t/situacao/ano/resolucao/mes) e a princípio parecia
 *   dar pra navegar direto nela. Só que testamos: a MESMA url com os
 *   MESMOS parâmetros retorna 0 resultados via page.goto(), mas
 *   retorna os dados reais quando alcançada por um clique dentro do
 *   site (confirmado por captura de tela real do usuário). A
 *   explicação mais provável é o header Referer — document.location.
 *   replace() (usado pela função btnActionClick() do próprio SIAET)
 *   herda o Referer da página atual; goto() não envia nenhum. Por
 *   isso o script agora entra pela navegação real uma vez
 *   (navegarParaListagem) e, pra cada mês, chama a própria função
 *   btnActionClick() do site de dentro da página já carregada (ver
 *   buscarMes) — preservando o Referer certo em toda requisição.
 *
 * `resolucao` fica fixo em 25 (Resolução 11/22, a que está em vigor
 * hoje — confirmado por captura de tela real com AETs de verdade
 * retornadas nessa combinação). Histórico mais antigo, sob outras
 * resoluções, exigiria looping também sobre outros values de
 * cboResolucao (1 a 24) — não deve ser necessário pros últimos 12
 * meses.
 *
 * `situacao=ALL` já cobre todos os status (liberada, cancelada, em
 * análise etc.) — é o valor padrão da tela também.
 *
 * Pré-requisitos:
 *   npm install @supabase/supabase-js   (se ainda não estiver no projeto)
 *   Este arquivo deve ficar na mesma pasta de siaet_login_completo.js,
 *   captcha_ocr.js e captcha_playwright.js (ex: scripts/popular_aets.js
 *   dentro do repo aet-rpa).
 *
 * IMPORTANTE — autenticação no Supabase:
 *   O backend é Lovable Cloud, então não existe service role key
 *   acessível (fica só internamente nas Edge Functions do Lovable).
 *   A tabela `aets` tem RLS habilitado com a policy `aets_all`
 *   (ALL, role authenticated, using true) — ou seja, QUALQUER usuário
 *   autenticado pode ler/escrever, não precisa ser admin.
 *
 *   Por isso o script faz login via supabase.auth.signInWithPassword()
 *   usando um usuário já cadastrado em `profiles`, antes de qualquer
 *   upsert — com isso a chave publishable + sessão autenticada já
 *   satisfazem a policy, sem precisar de nenhuma chave especial.
 *
 *   Adicione no .env:
 *     SUPABASE_AUTH_EMAIL=<email de um usuário existente em profiles>
 *     SUPABASE_AUTH_PASSWORD=<senha desse usuário>
 *
 *   Dica: pra não misturar com login pessoal de alguém, vale criar
 *   depois um usuário dedicado só pra scripts de automação — mas pra
 *   essa fase de prototipagem, reaproveitar uma conta existente já
 *   resolve.
 *
 * IMPORTANTE — upsert por numero_aet:
 *   O onConflict abaixo assume que existe uma constraint UNIQUE na
 *   coluna numero_aet. Se não existir, rode antes no SQL Editor:
 *     ALTER TABLE aets ADD CONSTRAINT aets_numero_aet_key UNIQUE (numero_aet);
 *   Sem isso, rodar o script mais de uma vez vai duplicar as AETs.
 */

require('dotenv').config();

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const { fazerLoginCompleto } = require('./siaet_login_completo.js');

// ---------------------------------------------------------------
// Cliente Supabase — usa a publishable key (é a única disponível em
// projetos Lovable Cloud). Sozinha ela só teria acesso de leitura
// pública; o acesso de escrita vem da sessão autenticada aberta por
// autenticarSupabase() logo no início da execução.
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

  console.log(`Autenticado no Supabase como ${data.user.email}.`);
}

// ---------------------------------------------------------------
// Entra na listagem de AETs pelo caminho real do site: menu
// TRANSPORTADOR > Listar AET. Confirmado por screenshot real do
// usuário — não é "AET" no menu superior, é um submenu dentro de
// "TRANSPORTADOR".
//
// Por que não usar page.goto() direto na URL final? Testamos e a
// mesma URL, com os mesmos parâmetros, retorna 0 resultados via
// goto() mas retorna os dados reais quando alcançada por clique.
// A explicação mais provável é o header Referer: navegações via JS
// disparadas de dentro de uma página (como document.location.replace,
// que é o que btnActionClick() usa) enviam o Referer da página atual;
// page.goto() não envia. O SIAET parece exigir isso. Por isso agora
// entramos uma vez pelo clique real, e as trocas de mês/ano usam a
// própria função btnActionClick() do site (ver buscarMes), que roda
// de dentro da página já carregada — preservando o Referer certo.
// ---------------------------------------------------------------

async function navegarParaListagem(page) {
  await page.getByText('TRANSPORTADOR', { exact: true }).click();
  await page.getByText('Listar AET', { exact: true }).click();
  await page.waitForSelector('select[name="cboResolucao"]');
}

// ---------------------------------------------------------------
// Gera a lista dos últimos 12 meses (ano, mes) a partir de hoje,
// mais recente primeiro.
// ---------------------------------------------------------------

function gerarUltimos12Meses() {
  const hoje = new Date();
  const meses = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    meses.push({ ano: d.getFullYear(), mes: d.getMonth() + 1 });
  }
  return meses;
}

// ---------------------------------------------------------------
// Converte data no formato brasileiro (dd/mm/aaaa) para ISO
// (aaaa-mm-dd), formato que o Postgres espera em colunas date.
// Retorna null se a célula estiver vazia (comum em "Data de
// Vencimento" quando a AET ainda não foi liberada).
// ---------------------------------------------------------------

function parseDataBr(dataStr) {
  if (!dataStr) return null;
  const match = dataStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dia, mes, ano] = match;
  return `${ano}-${mes}-${dia}`;
}

// ---------------------------------------------------------------
// Extrai as linhas da tabela de resultados da página já carregada.
// Seletor `table[border="1"]` é único na página (a tabela de
// filtros usa border="0") — confirmado no HTML real.
// ---------------------------------------------------------------

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

  // Descarta linhas sem número de AET (proteção contra linha em
  // branco residual, ex: separador entre cabeçalho e dados).
  return linhas.filter((l) => l.numero_aet);
}

// ---------------------------------------------------------------
// Busca um mês específico e devolve os registros já no formato da
// tabela `aets`.
// ---------------------------------------------------------------

async function buscarMes(page, ano, mes) {
  console.log(`Buscando AETs de ${String(mes).padStart(2, '0')}/${ano}...`);

  // Em vez de montar uma URL e dar goto() nela (que retorna vazio —
  // ver explicação em navegarParaListagem), preenchemos os <select>
  // de verdade via DOM e chamamos a função btnActionClick() do
  // próprio site, exatamente como um clique manual faria. Setar
  // .value diretamente (em vez de page.selectOption, que dispara
  // 'change' a cada chamada) evita disparar navegação prematura
  // antes dos 4 campos estarem todos com o valor certo.
  //
  // resolucao=25 é a "Resolução 11/22" — resolução em vigor desde
  // 2022, cobre as AETs dos últimos 12 meses (ver justificativa
  // completa no cabeçalho do arquivo).
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

  // Verificação de sessão: se a navegação caiu de volta na tela de
  // login (sessão expirou / SIAET rejeitou a requisição) em vez de
  // mostrar a listagem, o seletor da tabela nunca vai aparecer — sem
  // essa checagem, o script ficaria "preso" até estourar o timeout
  // padrão de 30s, parecendo travado sem explicação nenhuma.
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
      `volta pra tela de login em vez de mostrar a listagem. Provável ` +
      `timeout de sessão por inatividade ou navegação rápida demais.`
    );
  }

  if (resultado === 'nenhum') {
    await page.screenshot({ path: `erro-sessao-${ano}-${mes}.png` });
    throw new Error(
      `Nem a tabela de resultados nem a tela de login apareceram em 15s ` +
      `ao buscar ${mes}/${ano} — situação não mapeada. Screenshot salvo ` +
      `em erro-sessao-${ano}-${mes}.png.`
    );
  }

  const linhasBrutas = await extrairLinhasDaTabela(page);
  console.log(`  ${linhasBrutas.length} AET(s) encontrada(s).`);

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
// Upsert no Supabase — usa numero_aet como chave de conflito, então
// rodar o script de novo (ex: mês atual, que muda ao longo do
// tempo) atualiza em vez de duplicar.
//
// Timeout manual de 15s: sem isso, um problema de rede (DNS, proxy,
// firewall da WSL bloqueando o host do Supabase etc.) faz o upsert
// ficar pendurado indefinidamente e SEM NENHUM ERRO no terminal —
// foi exatamente esse silêncio que apareceu no vídeo (página parada
// em Julho/2026 por ~20s sem avançar). Com o timeout, se travar de
// novo, aparece uma mensagem de erro clara em vez de ficar mudo.
// ---------------------------------------------------------------

function comTimeout(promessa, ms, mensagemErro) {
  return Promise.race([
    promessa,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(mensagemErro)), ms)
    ),
  ]);
}

async function salvarNoSupabase(registros) {
  if (registros.length === 0) return;

  console.log(`  Salvando ${registros.length} registro(s) no Supabase...`);

  const { error } = await comTimeout(
    supabase.from('aets').upsert(registros, { onConflict: 'numero_aet' }),
    15000,
    'Timeout de 15s esperando resposta do Supabase — possível problema ' +
    'de rede/DNS/firewall da WSL bloqueando o host do Supabase, ou a ' +
    'sessão de auth expirou.'
  );

  if (error) {
    console.error('  Erro ao salvar no Supabase:', error.message);
    throw error;
  }

  console.log('  Salvo.');
}

// ---------------------------------------------------------------
// EXECUÇÃO
// ---------------------------------------------------------------

(async () => {
  // headless: false de propósito — fase de testes, rodando pela WSL
  // pra acompanhar visualmente. Trocar para true quando for migrar
  // pro servidor, depois de validado.
  const browser = await chromium.launch({ headless: false, slowMo: 1000 });

  // Gravação de vídeo: precisa vir de um context (não dá pra gravar
  // direto numa page criada via browser.newPage()). O arquivo só é
  // finalizado no disco quando o context é fechado — por isso o
  // context.close() explícito no finally, antes do browser.close().
  const context = await browser.newContext({
    recordVideo: { dir: 'videos/', size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();

  try {
    await autenticarSupabase();
    await fazerLoginCompleto(page);
    console.log('Login concluído.');

    await navegarParaListagem(page);
    console.log('Entrou na listagem de AETs — iniciando varredura dos últimos 12 meses.\n');

    const meses = gerarUltimos12Meses();

    let totalGeral = 0;
    for (const { ano, mes } of meses) {
      const registros = await buscarMes(page, ano, mes);
      await salvarNoSupabase(registros);
      totalGeral += registros.length;
      await page.waitForTimeout(500); // pequena pausa entre requisições
    }

    console.log(`\nConcluído. ${totalGeral} AET(s) processada(s) no total.`);
  } catch (erro) {
    console.error('Falha no script:', erro.message);
    await page.screenshot({ path: 'erro-popular-aets.png' });
  } finally {
    const video = page.video(); // pega a referência ANTES de fechar
    await context.close(); // fecha o context — é isso que grava o vídeo no disco
    await browser.close();
    if (video) {
      const videoPath = await video.path(); // só resolve depois do context fechado
      console.log(`Vídeo salvo em: ${videoPath}`);
    }
  }
})();