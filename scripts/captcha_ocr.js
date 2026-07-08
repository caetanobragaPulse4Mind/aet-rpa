/**
 * Resolução do CAPTCHA numérico do SIAET via OCR local (Tesseract)
 *
 * Pipeline: remoção de borda + ampliação 8x + mediana +
 * binarização Otsu + normalização de polaridade + filtro de blobs
 * + dilatação + múltiplos PSMs.
 *
 * HISTÓRICO:
 * 1. Escala 8x e corte de borda (BORDA_TOPO).
 * 2. Threshold fixo → Otsu adaptativo.
 * 3. Median pós-threshold removido (destruía fonte dot-matrix).
 * 4. Múltiplos PSMs por tentativa (7, 8, 6).
 * 5. Filtro de blobs: remove componentes conectados menores que
 *    TAMANHO_MINIMO_BLOB px² após binarização.
 * 6. Dilatação após blob removal: engrossa traços finos (ex: "1")
 *    que o Tesseract tendia a ignorar na análise de layout.
 *    Técnica: negate → blur → threshold(baixo) → negate
 *    = dilation de ~2-3px sem afetar espaçamento entre dígitos.
 * 7. PSM 13 adicionado: raw line mode, bypassa analisador de layout
 *    do Tesseract — melhor para fontes dot-matrix incomuns.
 * 8. TAMANHO_MINIMO_BLOB: 600 → 400 — margem mais segura para partes
 *    finas de dígitos que ficavam abaixo do limite anterior.
 * 9. Candidatos expandidos de 5 para 9 (Otsu ±60, passo ~15).
 * 10. normalizarParaFundoBranco: detecta captchas de fundo escuro
 *    (busca de AET) e inverte antes do blob filter e dilatação.
 *    Bug anterior: const { data } = await sharp(...).raw().toBuffer()
 *    — toBuffer() sem resolveWithObject retorna o buffer diretamente,
 *    não um objeto {data, info}. Corrigido: const rawBuf = await ...
 *
 * Pré-requisitos:
 *   sudo apt install -y tesseract-ocr
 *   npm install sharp node-tesseract-ocr
 */

const sharp = require('sharp');
const tesseract = require('node-tesseract-ocr');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const ESCALA = 8;
const BORDA_TOPO = 3;

// PSM 7  = single line | PSM 8 = single word
// PSM 13 = raw line (bypassa layout analysis — melhor para dot-matrix)
// PSM 6  = uniform block (fallback)
const PSMS = [7, 8, 13, 6];

// Tamanho mínimo (px²) de um blob para ser preservado.
// Pontos do fundo após 8x: ~150-400 px². Traços finos de dígitos: ~500+ px².
// Diminua se dígitos sumirem; aumente se pontos persistirem.
const TAMANHO_MINIMO_BLOB = 400;

const SALVAR_CAPTCHAS = process.env.SALVAR_CAPTCHAS === '1';
const PASTA_CAPTURAS = path.join(process.cwd(), 'capturas-captcha');

// ─── helpers internos ────────────────────────────────────────────────────────

async function salvarImagem(buffer, nomeArquivo) {
  if (!SALVAR_CAPTCHAS) return;
  try {
    await fs.mkdir(PASTA_CAPTURAS, { recursive: true });
    await fs.writeFile(path.join(PASTA_CAPTURAS, nomeArquivo), buffer);
  } catch { /* debug nunca derruba o fluxo principal */ }
}

async function rodarOcr(buffer, psm) {
  const caminhoTemp = path.join(
    os.tmpdir(),
    `captcha-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  );
  await fs.writeFile(caminhoTemp, buffer);
  try {
    const texto = await tesseract.recognize(caminhoTemp, {
      lang: 'eng',
      psm,
      tessedit_char_whitelist: '0123456789',
    });
    return texto.replace(/\D/g, '').trim();
  } finally {
    await fs.unlink(caminhoTemp).catch(() => {});
  }
}

/**
 * Garante que a imagem binária saia sempre com fundo branco e dígitos
 * pretos — independente do captcha ser fundo claro (login) ou fundo
 * escuro (busca de AET).
 *
 * O captcha de login tem fundo branco + dígitos pretos (padrão).
 * O captcha da busca de AET tem fundo PRETO + dígitos brancos.
 * Todo o pipeline (blob removal, dilatarTracos) foi projetado para
 * fundo branco. Com fundo preto, dilatarTracos aplica erosão em vez
 * de dilatação — dígitos somem em vez de engrossar.
 *
 * Nota: sharp().raw().toBuffer() SEM resolveWithObject retorna o
 * buffer diretamente (não {data, info}). Por isso usamos rawBuf
 * diretamente, sem desestruturar.
 */
async function normalizarParaFundoBranco(imagemBuffer) {
  const rawBuf = await sharp(imagemBuffer).greyscale().raw().toBuffer();
  const brancos = rawBuf.reduce((n, px) => n + (px >= 128 ? 1 : 0), 0);

  // Captcha com fundo escuro: < 40% de pixels brancos → inverte
  if (brancos / rawBuf.length < 0.40) {
    return sharp(imagemBuffer).negate().png().toBuffer();
  }
  return imagemBuffer;
}

/**
 * Remove componentes conectados menores que TAMANHO_MINIMO_BLOB pixels.
 * BFS com 8-vizinhança sobre imagem binária (preto=dígito, branco=fundo).
 *
 * @param {Buffer} imagemBuffer  Buffer PNG binarizado (0 ou 255)
 * @returns {Promise<Buffer>}    Buffer PNG limpo
 */
async function removerPontosIsolados(imagemBuffer) {
  const { data, info } = await sharp(imagemBuffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const pixels = data;                    // Uint8Array, 0=preto 255=branco
  const visited = new Uint8Array(width * height);
  const resultado = Buffer.from(pixels);  // cópia que vamos modificar

  // Offsets de 8-vizinhança: ↑↗→↘↓↙←↖
  const dxs = [-1, 0, 1, 1, 1, 0, -1, -1];
  const dys = [-1, -1, -1, 0, 1, 1, 1, 0];

  for (let i = 0; i < pixels.length; i++) {
    if (visited[i] || pixels[i] >= 128) continue; // branco ou já processado

    // BFS — usa ponteiro de cabeça para evitar .shift() O(n)
    const fila = [i];
    const componente = [i];
    visited[i] = 1;
    let head = 0;

    while (head < fila.length) {
      const idx = fila[head++];
      const x = idx % width;
      const y = Math.floor(idx / width);

      for (let d = 0; d < 8; d++) {
        const nx = x + dxs[d];
        const ny = y + dys[d];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (visited[nIdx] || pixels[nIdx] >= 128) continue;
        visited[nIdx] = 1;
        fila.push(nIdx);
        componente.push(nIdx);
      }
    }

    // Apaga o componente se for menor que o mínimo (ponto do fundo)
    if (componente.length < TAMANHO_MINIMO_BLOB) {
      for (const idx of componente) resultado[idx] = 255;
    }
  }

  return sharp(resultado, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/**
 * Dilata levemente os traços após blob removal.
 *
 * Problema: dígito "1" (traço fino) era ignorado pelo analisador de
 * layout do Tesseract, produzindo leituras de 4 dígitos em vez de 5.
 * Solução: negate → blur(1.5) → threshold(30) → negate
 * = dilation de ~2-3 pixels — engrossa "1" sem fundir dígitos adjacentes.
 *
 * threshold(30): qualquer pixel com intensidade >= 30 após o blur vira
 * branco (logo, após o segundo negate, vira preto = dígito).
 * Isso inclui pixels adjacentes à borda do dígito original → dilation.
 *
 * Pré-condição: imagem deve estar com fundo BRANCO e dígitos PRETOS.
 * A normalizarParaFundoBranco garante isso antes desta função rodar.
 */
async function dilatarTracos(imagemBuffer) {
  return sharp(imagemBuffer)
    .negate()          // dígitos=branco, fundo=preto
    .blur(1.5)         // suaviza bordas (~2-3px raio efetivo)
    .threshold(30)     // mantém tudo que estava perto de um dígito
    .negate()          // restaura: dígitos=preto, fundo=branco
    .png()
    .toBuffer();
}

/**
 * Binariza, normaliza polaridade, remove pontos, dilata e tenta
 * múltiplos PSMs.
 */
async function binarizarEOcr(imagemBase, threshold) {
  // 1. Binariza com o threshold dado
  const imagemBinaria = await sharp(imagemBase)
    .threshold(threshold)
    .png()
    .toBuffer();

  // 2. Normaliza orientação: garante fundo branco, dígitos pretos.
  //    Necessário para captchas de fundo escuro (busca de AET).
  //    No captcha de login (fundo claro) não faz nada.
  const imagemNormalizada = await normalizarParaFundoBranco(imagemBinaria);

  // 3. Remove pontos isolados do fundo
  const imagemSemPontos = await removerPontosIsolados(imagemNormalizada);

  // 4. Dilata levemente para engrossar traços finos (ex: dígito "1")
  const imagemFinal = await dilatarTracos(imagemSemPontos);

  // 5. Tenta múltiplos PSMs, retorna o primeiro com 5 dígitos
  let melhorParcial = '';
  let melhorPsm = null;

  for (const psm of PSMS) {
    const digitos = await rodarOcr(imagemFinal, psm);
    if (digitos.length === 5) {
      return { digitos, imagem: imagemFinal, psm };
    }
    if (digitos.length > melhorParcial.length) {
      melhorParcial = digitos;
      melhorPsm = psm;
    }
  }

  return { digitos: melhorParcial, imagem: imagemFinal, psm: melhorPsm };
}

/**
 * Calcula threshold ótimo pelo método de Otsu.
 *
 * Otsu encontra o valor t que maximiza a variância entre as duas
 * classes (pixels abaixo de t = escuros/dígitos; acima = fundo),
 * sem precisar de nenhum valor fixo pré-definido.
 *
 * @param {Buffer} rawBuffer  Buffer de pixels raw (greyscale, 1 byte/pixel)
 * @param {number} total      Número total de pixels
 * @returns {number}          Threshold ótimo (0–255)
 */
function calcularOtsu(rawBuffer, total) {
  // 1. Histograma de intensidades
  const hist = new Array(256).fill(0);
  for (const px of rawBuffer) hist[px]++;

  // 2. Soma total ponderada (para calcular médias globais)
  let somaTotal = 0;
  for (let i = 0; i < 256; i++) somaTotal += i * hist[i];

  let somaFundo = 0;
  let pixelsFundo = 0;
  let maxVariancia = 0;
  let threshold = 128; // fallback seguro

  for (let t = 0; t < 256; t++) {
    pixelsFundo += hist[t];
    if (pixelsFundo === 0) continue;

    const pixelsFrente = total - pixelsFundo;
    if (pixelsFrente === 0) break;

    somaFundo += t * hist[t];
    const mediaFundo = somaFundo / pixelsFundo;
    const mediaFrente = (somaTotal - somaFundo) / pixelsFrente;

    const variancia = pixelsFundo * pixelsFrente * (mediaFundo - mediaFrente) ** 2;
    if (variancia > maxVariancia) {
      maxVariancia = variancia;
      threshold = t;
    }
  }

  return threshold;
}

// ─── exports ─────────────────────────────────────────────────────────────────

/**
 * Verifica rapidamente se um buffer PNG está em branco.
 * Use antes de chamar resolverCaptchaSiaet para evitar processar
 * uma imagem que ainda não carregou na página.
 */
function imagemEmBranco(buffer) {
  if (buffer.length < 500) return true;
  let pixelsEscuros = 0;
  const limite = Math.min(buffer.length, 3000);
  for (let i = 33; i < limite; i++) {
    if (buffer[i] < 50) pixelsEscuros++;
  }
  return pixelsEscuros < 30;
}

/**
 * Recebe o buffer da screenshot do captcha e devolve os 5 dígitos.
 *
 * Tenta Otsu e 8 ajustes em torno dele (±60, passo ~15). Para cada
 * threshold, normaliza a polaridade da imagem, filtra blobs, dilata
 * e testa 4 modos PSM do Tesseract (7, 8, 13, 6).
 *
 * @param {Buffer} buffer  Buffer PNG direto do Playwright
 * @returns {Promise<string>} String com exatamente 5 dígitos
 */
async function resolverCaptchaSiaet(buffer) {
  if (imagemEmBranco(buffer)) {
    throw new Error('Captcha em branco — imagem ainda não carregou');
  }

  const metaOriginal = await sharp(buffer).metadata();
  const largura = metaOriginal.width;
  const altura = metaOriginal.height - BORDA_TOPO;

  // Pré-processamento comum (uma vez só, antes do loop de thresholds)
  //
  // PADDING DIREITO: o captcha original tem 88px de largura e ESCALA=8,
  // resultando em exatamente 704px após o resize — sem nenhuma margem.
  // Os dígitos chegam até a borda direita do frame. Depois da dilatação
  // (~3px para fora), o último dígito perde sua borda e fica amputado,
  // fazendo o OCR retornar 4 dígitos em vez de 5.
  // Solução: estender 32px à direita (= 4px no original × ESCALA) com
  // preto, combinando com o fundo escuro do captcha da busca de AET.
  const PADDING_DIREITO = 32;

  const imagemBase = await sharp(buffer)
    .extract({ left: 0, top: BORDA_TOPO, width: largura, height: altura })
    .greyscale()
    .resize(largura * ESCALA, altura * ESCALA, { kernel: 'lanczos3' })
    .extend({ right: PADDING_DIREITO, background: { r: 0, g: 0, b: 0 } })
    .median(3)
    .toBuffer();

  // Otsu sobre a imagem pré-processada
  const rawPixels = await sharp(imagemBase).raw().toBuffer();
  const totalPixels = (largura * ESCALA + PADDING_DIREITO) * altura * ESCALA;
  const otsu = calcularOtsu(rawPixels, totalPixels);

  // 5 candidatos: Otsu de -40 a 0.
  // Baseado em dados empíricos: todos os acertos aconteceram entre
  // t181-t184, que corresponde a Otsu-20 a Otsu-40 para estes captchas.
  // Thresholds acima de Otsu nunca venceram — removidos para evitar
  // tentativas inúteis e reduzir o tempo por imagem de captcha.
  // Total: 5 thresholds × 4 PSMs = 20 chamadas OCR por imagem.
  const candidatos = [-40, -30, -20, -10, 0]
    .map(delta => Math.max(1, Math.min(254, otsu + delta)));

  const timestamp = Date.now();
  const tentativas = [];

  for (const threshold of candidatos) {
    const delta = threshold - otsu;
    const label = delta === 0
      ? `otsu(${otsu})`
      : `otsu${delta > 0 ? '+' : ''}${delta}(${threshold})`;

    const { digitos, imagem, psm } = await binarizarEOcr(imagemBase, threshold);
    tentativas.push(`${label}→"${digitos}"${psm ? `[psm${psm}]` : ''}`);

    await salvarImagem(imagem, `${timestamp}_t${threshold}_${digitos || 'vazio'}.png`);

    if (digitos.length === 5) {
      await salvarImagem(buffer, `${timestamp}_${digitos}_ORIGINAL.png`);
      return digitos;
    }
  }

  // Não usa fallback de 6 dígitos: um resultado de 6 dígitos quase sempre
  // indica leitura errada (ex: "960012" quando a resposta é "86812" — o
  // "8" sendo dividido em "96" + "0"). Submeter os primeiros 5 seria quase
  // certamente errado, desperdiçando uma tentativa no site.
  // Melhor descartar esta imagem e pedir uma nova ao servidor.
  await salvarImagem(buffer, `${timestamp}_FALHOU_ORIGINAL.png`);
  throw new Error(
    `Otsu (${otsu}) e ajustes não retornaram 5 dígitos. ` +
    `Tentativas: ${tentativas.join(', ')}`
  );
}

module.exports = { resolverCaptchaSiaet, imagemEmBranco };