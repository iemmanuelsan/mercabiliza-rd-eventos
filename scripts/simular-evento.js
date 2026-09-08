/* =============================================================================
 *  SIMULAÇÃO DA FUNCTION DE EVENTO COM A API FALSA (nada é enviado ao CRM)
 *
 *  Uso:  node scripts/simular-evento.js
 *
 *  Substitui o fetch global por um dublê que registra e responde às chamadas.
 *  Serve para inspecionar, linha por linha, os payloads que serão enviados
 *  para /contacts, /deals e /activities antes de tocar na conta real.
 * ========================================================================== */

'use strict';

process.env.RD_CRM_TOKEN = 'TOKEN_DE_TESTE';

const chamadas = [];

/* --------- Dublê do fetch: responde como a API do RD Station CRM ---------- */
global.fetch = async function (url, init) {
  const metodo = (init && init.method) || 'GET';
  const corpo  = init && init.body ? JSON.parse(init.body) : null;
  const limpa  = String(url).replace(/token=[^&]*/, 'token=***');
  chamadas.push({ metodo, url: limpa, corpo });

  // GET /organizations — simula "empresa ainda não cadastrada".
  if (metodo === 'GET' && limpa.indexOf('/api/v1/organizations') > -1) {
    return resposta(200, { organizations: [], has_more: false, total: 0 });
  }
  // POST /organizations — devolve a empresa criada.
  if (metodo === 'POST' && limpa.indexOf('/api/v1/organizations') > -1) {
    return resposta(200, { _id: 'EMPRESA_FAKE_1', name: corpo.organization.name });
  }
  // GET /contacts — simula "contato ainda não existe".
  if (metodo === 'GET' && limpa.indexOf('/api/v1/contacts') > -1) {
    return resposta(200, { contacts: [], has_more: false, total: 0 });
  }
  // POST /contacts — devolve um contato criado.
  if (metodo === 'POST' && limpa.indexOf('/api/v1/contacts') > -1) {
    return resposta(200, { _id: 'CONTATO_FAKE_1', name: corpo.contact.name, emails: corpo.contact.emails || [] });
  }
  // POST /deals — devolve a negociação criada.
  if (metodo === 'POST' && limpa.indexOf('/api/v1/deals') > -1) {
    return resposta(200, { _id: 'DEAL_FAKE_1', name: corpo.deal.name });
  }
  // POST /activities — devolve a anotação criada.
  if (metodo === 'POST' && limpa.indexOf('/api/v1/activities') > -1) {
    return resposta(200, { _id: 'ATIVIDADE_FAKE_1', text: corpo.activity.text });
  }
  return resposta(404, { error: 'rota não simulada' });
};

function resposta(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: async () => JSON.stringify(json),
  };
}

/* ------------------------------ Payload de teste ------------------------- */
const RELATORIO = [
  '*DIAGNÓSTICO MERCABILIZA — SUMMIT*',
  '───────────────',
  '*Nome:* João Pedro da Silva',
  '*Cidade:* Sorocaba / SP',
  '*E-mail:* joao@compactstore.com.br',
  '*Já tem minimercado:* Sim, já opera',
  '*Tipo de operação:* Franquia ou licença',
  '*Franquia / licença:* Compact Store',
  '*Quantidade de lojas:* 6 lojas',
  '*Faturamento mensal (total):* R$ 120 mil / mês',
  '*Sistema de gestão:* AMLabs',
  '*Emite NFC-e:* Sim, emite NFC-e',
  '*Prioridade:* Eficiência tributária (pagar menos impostos)',
  '*Empresa aberta:* Sim, tem CNPJ',
  '*Regime tributário:* Simples Nacional',
  '*CNPJ:* 51.491.291/0001-07',
  '   _MERCABILIZA CONTABILIDADE LTDA_',
  '   _Situação: ATIVA_',
  '*Já tem contador:* Sim, já tem contador',
  '───────────────',
  'Consultor: Rafael',
  'Respondido em 02/09/2026 10:31:00',
].join('\n');

const evento = {
  httpMethod: 'POST',
  body: JSON.stringify({
    message: RELATORIO,
    respostas: [
      { campo: 'nome',        rotulo: 'Nome',                 valor: 'João Pedro da Silva' },
      { campo: 'cidade',      rotulo: 'Cidade',               valor: 'Sorocaba / SP' },
      { campo: 'email',       rotulo: 'E-mail',               valor: 'joao@compactstore.com.br' },
      { campo: 'temLoja',     rotulo: 'Já tem minimercado',   valor: 'Sim, já opera' },
      { campo: 'operacao',    rotulo: 'Tipo de operação',     valor: 'Franquia ou licença' },
      { campo: 'franquiaQual',rotulo: 'Franquia / licença',   valor: 'Compact Store' },
      { campo: 'qtdLojas',    rotulo: 'Quantidade de lojas',  valor: '6 lojas' },
      { campo: 'sistema',     rotulo: 'Sistema de gestão',    valor: 'AMLabs' },
      { campo: 'temEmpresa',  rotulo: 'Empresa aberta',       valor: 'Sim, tem CNPJ' },
      { campo: 'cnpj',        rotulo: 'CNPJ',                 valor: '51.491.291/0001-07' },
    ],
    receita: {
      razao: 'MERCABILIZA CONTABILIDADE LTDA',
      situacao: 'ATIVA',
      municipio: 'Sorocaba / SP',
      atividade: 'Atividades de contabilidade',
    },
    consultor: 'Rafael',
    telefone: '5519998887777',
    origem_evento: 'Summit',     // prefixo do card e texto da anotação
    origemUrl: 'https://mercabiliza-pre-diagnostico.netlify.app/evento/?t=5519998887777&n=Rafael&c=5519998887777',
    enviadoEm: new Date().toISOString(),
  }),
};

/* --------------------------------- Execução ------------------------------ */
(async function () {
  const { handler } = require('../netlify/functions/evento-diagnostico.js');
  const resultado = await handler(evento);

  console.log('\n══════════ CHAMADAS FEITAS À API ══════════');
  chamadas.forEach((c, i) => {
    console.log('\n[' + (i + 1) + '] ' + c.metodo + ' ' + c.url);
    if (c.corpo) console.log(JSON.stringify(c.corpo, null, 2));
  });

  console.log('\n══════════ RESPOSTA AO FORMULÁRIO ══════════');
  console.log('HTTP ' + resultado.statusCode);
  console.log(JSON.stringify(JSON.parse(resultado.body), null, 2));
})();