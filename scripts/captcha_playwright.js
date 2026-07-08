/**
 * Wrapper que liga o Playwright ao módulo de OCR puro (captcha_ocr.js).
 * Usado tanto no login quanto na busca de AET por número/ano — o
 * SIAET usa o mesmo captcha numérico de 5 dígitos nas duas telas.
 */

const { resolverCaptchaSiaet } = require('./captcha_ocr.js');

async function resolverCaptchaNaPagina(page, seletorImagem) {
  // O src da imagem aponta para um endpoint dinâmico (captcha.asp)
  // que gera uma imagem nova a cada carregamento. Sem essa espera,
  // o Playwright pode tirar o screenshot antes da imagem terminar
  // de carregar — resultando em uma captura em branco e o OCR
  // retornando string vazia.
  await page.waitForFunction(
    (sel) => {
      const img = document.querySelector(sel);
      return img && img.complete && img.naturalWidth > 0;
    },
    seletorImagem
  );

  const captchaBuffer = await page.locator(seletorImagem).screenshot();

  // O histórico de capturas (rotuladas com o palpite do OCR) é
  // salvo dentro de captcha_ocr.js — ver SALVAR_CAPTCHAS no .env.
  return resolverCaptchaSiaet(captchaBuffer);
}

async function gerarNovoCaptcha(page, seletorImagem) {
  // Força o navegador a buscar uma nova imagem do mesmo endpoint
  // dinâmico, sem precisar recarregar a página inteira (o que
  // perderia o estado de navegação já alcançado até aqui).
  await page.evaluate((sel) => {
    const img = document.querySelector(sel);
    const urlBase = img.src.split('?')[0];
    img.src = `${urlBase}?_=${Date.now()}`;
  }, seletorImagem);

  await page.waitForFunction(
    (sel) => {
      const img = document.querySelector(sel);
      return img && img.complete && img.naturalWidth > 0;
    },
    seletorImagem
  );
}

module.exports = { resolverCaptchaNaPagina, gerarNovoCaptcha };