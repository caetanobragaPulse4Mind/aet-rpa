/**
 * SIAET (DNIT) — Login completo até a tela principal
 *
 * Fluxo coberto:
 *   1. Abre a página inicial do SIAET
 *   2. Seleciona "Transportador Pessoa Jurídica"
 *   3. Resolve o CAPTCHA numérico (imagem de segurança)
 *   4. Preenche código de acesso + senha
 *   5. Clica em Entrar
 *   6. Fecha o modal de avisos/comunicados que aparece pós-login
 *   7. Confirma que chegou na tela principal (menu_resolucao.asp)
 *
 * Todos os seletores deste fluxo (card Pessoa Jurídica, campos de
 * login, botão Entrar, e fechamento do modal de avisos) foram
 * confirmados via HTML real das telas correspondentes.
 *
 * Este arquivo exporta as funções do fluxo para reuso em outros
 * scripts (ex: imprimir_aet.js) — rodar `node siaet_login_completo.js`
 * direto ainda funciona como teste isolado do login (ver bloco
 * EXECUÇÃO no final, que só roda quando o arquivo é chamado
 * diretamente, não quando é importado via require()).
 *
 * Pré-requisitos: npm install playwright dotenv sharp node-tesseract-ocr
 *                  npx playwright install --with-deps chromium
 *                  sudo apt install -y tesseract-ocr
 *                  (captcha_ocr.js e captcha_playwright.js precisam
 *                  estar na mesma pasta)
 */

// dotenv precisa vir ANTES do require de qualquer módulo que leia
// variáveis de ambiente no carregamento (não dentro de uma função) —
// captcha_ocr.js é um desses casos (SALVAR_CAPTCHAS).
require('dotenv').config();

const { chromium } = require('playwright');
const { resolverCaptchaNaPagina, gerarNovoCaptcha } = require('./captcha_playwright.js');

const SIAET_URL = 'https://siaet.dnit.gov.br/';

// ---------------------------------------------------------------
// Validação das variáveis de ambiente — falha rápido e com mensagem
// clara, em vez de deixar o Playwright estourar um erro genérico
// de "expected string, got undefined" lá na frente do fluxo.
// ---------------------------------------------------------------

function validarVariaveisDeAmbiente() {
  const obrigatorias = ['SIAET_CODIGO_ACESSO', 'SIAET_SENHA'];
  const faltando = obrigatorias.filter((nome) => !process.env[nome]);

  if (faltando.length > 0) {
    throw new Error(
      `Variável(is) de ambiente faltando ou vazia(s) no .env: ${faltando.join(', ')}. ` +
      `Confira se o arquivo .env está na pasta certa (~/aet-rpa) e se cada linha ` +
      `tem o formato NOME=valor, sem espaços ao redor do "=".`
    );
  }
}

// ---------------------------------------------------------------
// PASSO 1 — Selecionar "Transportador Pessoa Jurídica"
// ---------------------------------------------------------------

async function clicarCardPessoaJuridica(page) {
  // Confirmado via HTML real: é uma <img> dentro de <a onclick="login('pj')">,
  // mesma função JS usada no botão "Entrar" (login('entrar')), só com
  // parâmetro diferente. Mais estável que selecionar por texto.
  await page.click('a[onclick*="login(\'pj\')"]');

  // Confirma que o formulário de login (PJ) carregou
  await page.waitForSelector('input#securityCode');
}

async function selecionarPessoaJuridica(page) {
  await page.goto(SIAET_URL);
  await clicarCardPessoaJuridica(page);
}

// ---------------------------------------------------------------
// PASSO 2 — Login com retentativa automática
// ---------------------------------------------------------------
// Duas evidências reais (capturadas em testes) motivam esse retry:
//
// 1. O OCR pode retornar 5 dígitos com confiança, mas errados (ex:
//    leu "40040" quando a imagem era "40042" — confundiu "2" com
//    "0"). Isso passa pela validação de tamanho mas é rejeitado
//    pelo site, e sem detecção explícita disso o script ficava
//    preso 30s esperando uma navegação que nunca ia acontecer.
//
// 2. Algumas imagens são genuinamente difíceis (dígitos colados
//    visualmente) e nenhum dos 10 thresholds testados chega a 5
//    dígitos — não adianta insistir na MESMA imagem, mas a próxima
//    gerada pelo site costuma ser mais fácil.
//
// Como cada carregamento de captcha.asp gera uma imagem nova, pedir
// um captcha novo e tentar de novo é a forma mais simples e barata
// (sem depender de serviço pago) de contornar os dois casos.
//
// Taxa observada em testes reais: ~1 sucesso a cada 5 tentativas
// isoladas (confirmado em 4 rodadas completas: sucesso na 5ª, 7ª,
// 2ª e 6ª tentativa — média de 5, batendo com o esperado
// estatisticamente para uma taxa de 20%).

const TENTATIVAS_MAX_LOGIN = 100;

async function loginSiaet(page) {
  for (let tentativa = 1; tentativa <= TENTATIVAS_MAX_LOGIN; tentativa++) {
    console.log(`Tentativa de login ${tentativa}/${TENTATIVAS_MAX_LOGIN}...`);

    let digitosCaptcha;
    try {
      digitosCaptcha = await resolverCaptchaNaPagina(page, 'img#captcha');
    } catch (erroOcr) {
      // Caso 2: OCR não chegou a 5 dígitos em nenhum threshold.
      // Não adianta insistir na mesma imagem — pega uma nova.
      console.warn(`  OCR falhou: ${erroOcr.message}`);
      if (tentativa === TENTATIVAS_MAX_LOGIN) throw erroOcr;
      await gerarNovoCaptcha(page, 'img#captcha');
      continue;
    }

    await page.fill('input#securityCode', digitosCaptcha);
    await page.fill('input#txtCodigo', process.env.SIAET_CODIGO_ACESSO);
    await page.fill('input#txtSenhaAcesso', process.env.SIAET_SENHA);

    // Não é um submit nativo — é um <button type="button"> com
    // onclick="login('entrar')". Clicar normalmente é suficiente:
    // o JS da própria página cuida do envio.
    await page.click('button[name="cmdEntrar"]');

    // Corrida entre sucesso (navegou pra tela principal) e rejeição
    // explícita (página de erro "Imagem de validação digitada
    // incorretamente"). Timeout curto (8s) em vez dos 30s padrão —
    // se nenhum dos dois acontecer nesse prazo, algo mais estranho
    // está acontecendo e vale parar de insistir cegamente.
    const resultado = await Promise.race([
      page
        .waitForURL('**/menu_resolucao.asp', { timeout: 8000 })
        .then(() => 'sucesso'),
      page
        .getByText('incorretamente', { exact: false })
        .waitFor({ timeout: 8000 })
        .then(() => 'captcha_errado'),
    ]).catch(() => 'indefinido');

    if (resultado === 'sucesso') {
      console.log(`  Login bem-sucedido na tentativa ${tentativa}.`);
      return;
    }

    if (resultado === 'captcha_errado') {
      console.warn('  Site rejeitou o captcha — tentando de novo.');
      if (tentativa === TENTATIVAS_MAX_LOGIN) {
        throw new Error(
          `Login falhou após ${TENTATIVAS_MAX_LOGIN} tentativas ` +
          `(captcha rejeitado repetidamente pelo site).`
        );
      }
      // CONFIRMAR: seletor do botão "Voltar" da página de erro
      // ainda não validado contra o HTML real, só visto no print —
      // mesmo cuidado que tivemos antes com elementos não confirmados.
      await page.getByText('Voltar', { exact: true }).click();

      // Achado real em teste: o "Voltar" da página de erro leva de
      // volta à tela inicial (os três cards), não direto ao
      // formulário de login — precisa reselecionar "Pessoa
      // Jurídica" antes de tentar de novo.
      await clicarCardPessoaJuridica(page);
      continue;
    }

    // 'indefinido': nem sucesso nem erro de captcha detectado no
    // prazo — situação não mapeada, não vale insistir às cegas.
    throw new Error(
      `Resultado indefinido após submissão na tentativa ${tentativa} ` +
      `(nem sucesso nem erro de captcha foram detectados em 8s).`
    );
  }
}

// ---------------------------------------------------------------
// PASSO 3 — Fechar o modal de avisos/comunicados pós-login
// ---------------------------------------------------------------

async function fecharModalAvisos(page) {
  // Confirmado via inspeção do HTML real: o link "Fechar" não é um
  // componente de modal — é um <a href="javascript:void(0)"> que
  // simplesmente esconde dois elementos (#light = overlay, #fade =
  // conteúdo) via style.display='none'. Padrão clássico de ASP antigo.
  const botaoFechar = page.locator('a[onclick*="getElementById(\'light\')"]');

  if (await botaoFechar.isVisible().catch(() => false)) {
    await botaoFechar.click();
  }

  // Confirma que o overlay realmente sumiu antes de seguir
  await page.waitForSelector('#light', { state: 'hidden' }).catch(() => {});
}

// ---------------------------------------------------------------
// PASSO 4 — Confirmar que chegou na tela principal
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Atalho: faz o fluxo completo (login + fechamento do modal).
// Após retornar, a sessão está autenticada e o script pode navegar
// direto pra qualquer URL do SIAET via page.goto().
//
// confirmarTelaPrincipal foi removida: loginSiaet já garante a
// sessão via waitForURL('**/menu_resolucao.asp'). Tentar aguardar
// elementos do menu causava timeout porque 'text=AET' resolvia
// para 66 elementos — a maioria dentro de dropdowns fechados.
// Cada script chamador navega direto para a URL que precisa.
// ---------------------------------------------------------------

async function fazerLoginCompleto(page) {
  validarVariaveisDeAmbiente();
  await selecionarPessoaJuridica(page);
  await loginSiaet(page);
  await fecharModalAvisos(page);
}

module.exports = {
  SIAET_URL,
  validarVariaveisDeAmbiente,
  selecionarPessoaJuridica,
  clicarCardPessoaJuridica,
  loginSiaet,
  fecharModalAvisos,
  fazerLoginCompleto,
};

// ---------------------------------------------------------------
// EXECUÇÃO — só roda quando este arquivo é chamado diretamente
// (`node siaet_login_completo.js`), não quando é importado via
// require() por outro script.
// ---------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
      await fazerLoginCompleto(page);
      console.log('Login concluído — tela principal carregada.');
    } catch (erro) {
      console.error('Falha no fluxo de login:', erro.message);
      await page.screenshot({ path: 'erro-login-siaet.png' });
    } finally {
      await browser.close();
    }
  })();
}