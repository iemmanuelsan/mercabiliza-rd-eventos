/* =============================================================================
 *  SMOKE TEST DO FORMULÁRIO DO EVENTO (headless, sem tocar no CRM)
 *
 *  Uso:  node scripts/smoke-evento.js
 *
 *  Abre evento/index.html num Chromium headless, preenche o caminho mais
 *  curto até o resumo, intercepta a chamada à Netlify Function e confere:
 *    - o selo e o título trazem o nome do evento;
 *    - o endpoint chamado é o do evento;
 *    - o payload leva origem_evento, telefone (?c=) e o texto do WhatsApp
 *      começando com a saudação do stand;
 *    - o WhatsApp é aberto (window.open) com o mesmo texto;
 *    - nenhum erro de JavaScript aparece no console.
 * ========================================================================== */

'use strict';

const path = require('path');
const { chromium } = require('playwright');

const ARQUIVO = 'file://' + path.resolve(__dirname, '..', 'evento', 'index.html');
const QUERY = '?t=5519998887777&n=Rafael&c=5511988776655';

let falhas = 0;
function ok(titulo, condicao, detalhe) {
  if (condicao) { console.log('  ok   ' + titulo); }
  else { falhas++; console.log('  FALHA ' + titulo + (detalhe ? '\n        ' + detalhe : '')); }
}

(async () => {
  // CHROMIUM_PATH permite apontar para o binário local; sem ela, usa o que o
  // Playwright já conhece.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage();

  // Erros de JavaScript de verdade. Falha de REDE (consulta do IBGE e da
  // Receita) é esperada rodando offline, então fica de fora da conta.
  const errosJs = [];
  const ehRede = (t) => /Failed to load resource|ERR_|net::|Fetch|fetch/i.test(t);
  page.on('pageerror', (e) => errosJs.push(String(e && e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !ehRede(m.text())) errosJs.push('console: ' + m.text());
  });

  // Intercepta o POST da function e responde como a Netlify responderia.
  let payload = null;
  await page.route('**/.netlify/functions/**', async (rota) => {
    payload = { url: rota.request().url(), corpo: JSON.parse(rota.request().postData() || '{}') };
    await rota.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, deal_id: 'D1', evento: 'Summit' }) });
  });

  await page.goto(ARQUIVO + QUERY);

  // Neutraliza o window.open (não há navegador de verdade para o WhatsApp).
  await page.evaluate(() => {
    window.__aberto = null;
    window.open = (u) => { window.__aberto = u; return { focus() {} }; };
  });

  console.log('\n1) Identidade do evento na página');
  ok('selo com o nome do evento', (await page.textContent('#selo')) === 'Stand Mercabiliza · Summit',
     'selo: ' + (await page.textContent('#selo')));
  ok('título da aba', (await page.title()) === 'Diagnóstico Mercabiliza — Summit', await page.title());
  ok('intro com o consultor', (await page.textContent('#intro')).indexOf('Rafael') > -1);

  console.log('\n2) Percurso até o resumo');
  await page.fill('#nome', 'João Pedro da Silva');
  await page.fill('#cidade', 'Sorocaba / SP');
  await page.fill('#email', 'joao@compactstore.com.br');
  await page.click('#btnNext');                                  // etapa 1 ➔ 2

  await page.click('input[name="temLoja"][value="nao"]');         // ramo mais curto
  await page.click('input[name="fase"][value="Pesquisando o mercado"]');
  await page.click('input[name="prazoOperar"][value="2 meses"]');
  await page.click('input[name="operacaoFuturo"][value="Operação própria"]');
  await page.click('input[name="localFuturo"][value="Loja de rua"]');
  await page.click('#btnNext');                                  // etapa 2 ➔ 3

  await page.click('input[name="prioridade"][value="Preço da mensalidade"]');
  await page.click('#btnNext');                                  // etapa 3 ➔ 4

  await page.click('input[name="temEmpresa"][value="nao"]');
  await page.click('input[name="temContador"][value="Não"]');
  await page.click('#btnNext');                                  // etapa 4 ➔ resumo

  const resumo = await page.textContent('#preview');
  ok('resumo montado', resumo.length > 50);
  ok('saudação do stand no topo', resumo.indexOf('Olá! Preenchi o diagnóstico aqui no stand do Summit.') === 0,
     resumo.slice(0, 80));
  ok('cabeçalho do evento', resumo.indexOf('DIAGNÓSTICO MERCABILIZA — SUMMIT') > -1);
  ok('linha Evento no rodapé', resumo.indexOf('Evento: Summit') > -1);

  console.log('\n3) Envio');
  await page.click('#btnWa');
  await page.waitForTimeout(600);

  ok('function chamada', !!payload, 'nenhuma requisição interceptada');
  ok('endpoint do evento', payload && payload.url.indexOf('/.netlify/functions/evento-diagnostico') > -1,
     payload && payload.url);
  ok('origem_evento no payload', payload && payload.corpo.origem_evento === 'Summit',
     payload && String(payload.corpo.origem_evento));
  ok('telefone do link (?c=)', payload && payload.corpo.telefone === '5511988776655',
     payload && String(payload.corpo.telefone));
  ok('message com a saudação', payload && payload.corpo.message.indexOf('stand do Summit') > -1);
  ok('respostas estruturadas', payload && Array.isArray(payload.corpo.respostas) && payload.corpo.respostas.length >= 6,
     payload && String(payload.corpo.respostas && payload.corpo.respostas.length));

  const aberto = await page.evaluate(() => window.__aberto);
  ok('WhatsApp aberto', !!aberto && aberto.indexOf('https://wa.me/5519998887777') === 0, String(aberto));
  ok('texto do WhatsApp com a saudação', !!aberto && decodeURIComponent(aberto).indexOf('stand do Summit') > -1);

  console.log('\n4) Console limpo');
  ok('sem erros de JavaScript', errosJs.length === 0, errosJs.join(' | '));

  /* ---------------------------------------------------------------------
   *  5) REGRESSÃO: o formulário orgânico do site continua intacto?
   *     Mesmo percurso, conferindo que ele NÃO virou um formulário de evento.
   * ------------------------------------------------------------------- */
  console.log('\n5) Regressão do formulário orgânico (index.html)');
  const organico = await browser.newPage();
  let payloadOrg = null;
  await organico.route('**/.netlify/functions/**', async (rota) => {
    payloadOrg = { url: rota.request().url(), corpo: JSON.parse(rota.request().postData() || '{}') };
    await rota.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, deal_id: 'D2' }) });
  });
  await organico.goto('file://' + path.resolve(__dirname, '..', 'index.html') + QUERY);
  await organico.evaluate(() => { window.open = () => ({ focus() {} }); });

  await organico.fill('#nome', 'Maria Souza');
  await organico.fill('#cidade', 'Campinas / SP');
  await organico.click('#btnNext');
  await organico.click('input[name="temLoja"][value="nao"]');
  await organico.click('input[name="fase"][value="Pesquisando o mercado"]');
  await organico.click('input[name="prazoOperar"][value="2 meses"]');
  await organico.click('input[name="operacaoFuturo"][value="Operação própria"]');
  await organico.click('input[name="localFuturo"][value="Loja de rua"]');
  await organico.click('#btnNext');
  await organico.click('input[name="prioridade"][value="Preço da mensalidade"]');
  await organico.click('#btnNext');
  await organico.click('input[name="temEmpresa"][value="nao"]');
  await organico.click('input[name="temContador"][value="Não"]');
  await organico.click('#btnNext');
  await organico.click('#btnWa');
  await organico.waitForTimeout(600);

  ok('endpoint orgânico inalterado',
     payloadOrg && payloadOrg.url.indexOf('/.netlify/functions/pre-diagnostico') > -1,
     payloadOrg && payloadOrg.url);
  ok('sem origem_evento no payload orgânico',
     payloadOrg && payloadOrg.corpo.origem_evento === undefined);
  ok('sem saudação de stand no resumo orgânico',
     payloadOrg && payloadOrg.corpo.message.indexOf('stand') === -1);
  ok('cabeçalho orgânico preservado',
     payloadOrg && payloadOrg.corpo.message.indexOf('PRÉ-DIAGNÓSTICO MERCABILIZA') > -1);

  await browser.close();
  console.log('\n──────────────────────────────');
  console.log(falhas ? '  ' + falhas + ' falha(s)' : '  tudo ok');
  process.exit(falhas ? 1 : 0);
})();