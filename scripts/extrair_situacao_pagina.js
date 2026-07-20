/**
 * Extração dos campos de "Situação da AET" — compartilhado entre
 * imprimir_aet.js (quando o cmdImprimirAET não aparece porque a AET
 * foi devolvida) e consultar_situacao_aet.js (consulta direta via
 * manSituacaoAet.asp). Os rótulos são idênticos nas duas telas, então
 * a lógica de leitura fica num lugar só.
 *
 * Abordagem: em vez de navegar a árvore do DOM célula por célula
 * (locator + xpath de célula vizinha), lê o texto renderizado da
 * página inteira (innerText) e localiza os rótulos linha por linha.
 * Essas páginas ASP antigas têm marcação bem inconsistente (fonts
 * aninhadas, divs de alinhamento, atributos malformados — o mesmo
 * padrão de "aspas soltas" já visto nos botões de submit) então
 * depender da estrutura exata de <td>/<tr> é frágil. innerText já
 * reflete o texto como o navegador renderiza, então é resistente a
 * essas variações de marcação.
 */

// Rótulos conhecidos, na ordem em que aparecem nas duas telas.
// Usado tanto pra identificar onde cada campo começa quanto pra saber
// onde ele termina (linhas seguintes até o próximo rótulo conhecido
// pertencem ao campo atual — importante pra "Observação Análise", que
// costuma vir em várias linhas).
const ROTULOS_CONHECIDOS = [
  'Situação da(s) Tarifa(s):',
  'Situação da AET:',
  'Observação Análise:',
];

// Linhas que indicam que a captura de um campo multi-linha (ex:
// Observação Análise) deve parar, mesmo sem ter achado o próximo
// rótulo conhecido. O link "Voltar" é uma imagem (sem texto no
// innerText), então não serve de sentinela — usamos os padrões de
// rodapé realmente observados na página (ex: "13 - AET NAO PRECISA
// DE TUV") e um limite de linhas como rede de segurança.
const MARCADORES_DE_FIM = [/^\d+\s*-\s*/];
const MAX_LINHAS_CAMPO_MULTILINHA = 6;

function extrairCamposDoTexto(texto) {
  const linhas = texto
    .split('\n')
    .map((linha) => linha.trim())
    .filter(Boolean);

  const valores = {};

  for (let i = 0; i < linhas.length; i++) {
    const rotulo = ROTULOS_CONHECIDOS.find((r) => linhas[i].startsWith(r));
    if (!rotulo) continue;

    let valor = linhas[i].slice(rotulo.length).trim();

    // Junta linhas seguintes que não começam com outro rótulo
    // conhecido nem batem com um marcador de fim — cobre campos
    // multi-linha como a Observação Análise, sem vazar pro rodapé.
    let j = i + 1;
    let linhasAdicionadas = 0;
    while (
      j < linhas.length &&
      linhasAdicionadas < MAX_LINHAS_CAMPO_MULTILINHA &&
      !ROTULOS_CONHECIDOS.some((r) => linhas[j].startsWith(r)) &&
      !MARCADORES_DE_FIM.some((regex) => regex.test(linhas[j]))
    ) {
      valor += (valor ? ' ' : '') + linhas[j];
      j++;
      linhasAdicionadas++;
    }

    valores[rotulo] = valor || null;
  }

  return {
    tipoPendencia: valores['Situação da AET:'] ? 'devolvida_correcao' : null,
    situacaoTarifa: valores['Situação da(s) Tarifa(s):'] || null,
    situacaoAet: valores['Situação da AET:'] || null,
    observacaoAnalise: valores['Observação Análise:'] || null,
  };
}

// Retorna os três campos como null se a página atual não tiver esse
// painel — permite chamar "no escuro" (ex: tentar extrair sempre que
// o botão de imprimir não aparecer) sem precisar checar antes se a
// tela é a certa.
async function extrairSituacao(page) {
  const textoPagina = await page.locator('body').innerText().catch(() => '');
  return extrairCamposDoTexto(textoPagina);
}

// Atalho pra decidir rapidamente se vale a pena tentar persistir o
// resultado (evita gravar linha vazia em aet_situacoes quando a
// página não tinha nenhum desses campos — ex: manProprietarioCarga).
function situacaoTemDados(situacao) {
  return Boolean(situacao.situacaoTarifa || situacao.situacaoAet || situacao.observacaoAnalise);
}

// ---------------------------------------------------------------
// Pendência de proprietário da carga (manProprietarioCarga.asp)
// ---------------------------------------------------------------
// Tela diferente da "Situação da AET" — pede nota fiscal/DAMDFE/DTA
// ou DI/DUIMP antes de liberar a impressão. Os campos do formulário
// (nome/razão social, número da nota, chave de acesso) são inputs,
// não texto renderizado — não dá pra ler via innerText como os
// outros campos. Por enquanto só detectamos e registramos QUE existe
// essa pendência (suficiente pra alimentar uma futura tela no front
// pedindo os dados ao usuário); se um dia for preciso automatizar o
// preenchimento desse formulário, aí sim vale mapear os seletores
// exatos dos inputs a partir do HTML real da página.
const TEXTO_PENDENCIA_PROPRIETARIO = 'deverá informar os dados da Nota Fiscal';

async function extrairPendenciaProprietario(page) {
  const textoPagina = await page.locator('body').innerText().catch(() => '');
  const temPendencia = textoPagina.includes(TEXTO_PENDENCIA_PROPRIETARIO);

  if (!temPendencia) return null;

  return {
    tipoPendencia: 'proprietario_carga',
    situacaoTarifa: null,
    situacaoAet: 'Faltam informações do proprietário da carga (Nota Fiscal, DAMDFE, DTA/DI ou DUIMP) — precisa ser preenchido no SIAET antes de imprimir.',
    observacaoAnalise: null,
  };
}

module.exports = { extrairSituacao, situacaoTemDados, extrairPendenciaProprietario };