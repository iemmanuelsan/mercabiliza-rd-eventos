/* =============================================================================
 *  CONFERÊNCIA DOS IDs DO RD STATION CRM  (somente leitura — não cria nada)
 *
 *  Uso:
 *     RD_CRM_TOKEN=seu_token node scripts/rd-crm-check.js
 *
 *  O script responde três perguntas antes do primeiro teste real:
 *     1. O token funciona?
 *     2. A etapa 6a70e1f68b8c0f00261e6af9 ("Lead Orgânico - LO") pertence ao
 *        funil 68adf82967a7b0001b5cc9e0 ("Funil - Mercabiliza")?
 *     3. Os 10 IDs de campos personalizados existem, estão no lugar certo
 *        (negociação x contato) e aceitam exatamente as opções mapeadas?
 * ========================================================================== */

'use strict';

const RD_HOST  = 'https://crm.rdstation.com';
const TOKEN    = process.env.RD_CRM_TOKEN || '';
const PIPELINE = process.env.RD_PIPELINE_ID || '68adf82967a7b0001b5cc9e0';
const STAGE    = process.env.RD_STAGE_ID    || '6a70e1f68b8c0f00261e6af9';

/* Mesmo mapeamento usado pela função — mantenha os dois lados em sincronia. */
const ESPERADO = [
  { id: '67323f79974b87001de29ac5', nome: 'Cidade',                        opcoes: null },
  { id: '67323fbb39b27d0013037211', nome: 'Estado',                        opcoes: null },
  { id: '6a88a6d962254a0024d72f8c', nome: '[MB] Status CNPJ',              opcoes: ['Ativo', 'Inativo / Baixado', 'Não Possui (PF)'] },
  { id: '69e0dcedac010300134dfaa8', nome: 'Número do CNPJ',                opcoes: null },
  { id: '6a8c3e7db55120002f55c759', nome: '[MB] Quantidade de Lojas',      opcoes: ['1 Loja (Matriz Única)', '2 a 5 Lojas', '6 a 15 Lojas', '16 a 50 Lojas', '+ 50 Lojas'] },
  { id: '6a8c3ef5906ac80025b0cf51', nome: '[MB] Modelo de Rede',           opcoes: ['Operação Própria (OpP)', 'Franquia / Franqueado'] },
  { id: '67d9c07b0e56fe001b6f6217', nome: 'Franquia',                      opcoes: null },
  { id: '6a8f2b852843650025bc2706', nome: '[MB] Sistema de Gestão (ERP/PDV)', opcoes: null },
  { id: '6a8f287ac63bbc002ad43597', nome: '[MB] Status Operacional',       opcoes: ['Em Operação Normal'] },
  // "Evento / Feira" é usado pela function do evento (evento-diagnostico.js).
  // Se ela ainda não existir na lista de opções do campo, o valor chega vazio
  // no card — crie a opção no CRM antes do evento.
  { id: '6a88a5816caedd0020878de8', nome: '[MB] Fonte/Origem',             opcoes: ['Inbound / Orgânico', process.env.EVENTO_FONTE_ORIGEM || 'Evento / Feira'] },
];

/** GET simples na API, já com o token na query string. */
async function get(caminho, query) {
  const qs = new URLSearchParams(Object.assign({ token: TOKEN }, query || {}));
  const resposta = await fetch(RD_HOST + caminho + '?' + qs.toString(), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const texto = await resposta.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (_e) { dados = { raw: texto }; }
  return { ok: resposta.ok, status: resposta.status, dados };
}

/** Aceita respostas em array puro ou embrulhadas em uma chave. */
function lista(dados, chave) {
  if (Array.isArray(dados)) return dados;
  if (dados && Array.isArray(dados[chave])) return dados[chave];
  return [];
}

(async function main() {
  if (!TOKEN) {
    console.error('Defina RD_CRM_TOKEN antes de rodar. Ex.:');
    console.error('   RD_CRM_TOKEN=seu_token node scripts/rd-crm-check.js');
    process.exit(1);
  }

  /* ---------------------------- 1. Token válido? -------------------------- */
  console.log('\n1) Testando o token...');
  const teste = await get('/api/v1/deal_pipelines');
  if (!teste.ok) {
    console.error('   ✗ token recusado (HTTP ' + teste.status + '):', JSON.stringify(teste.dados));
    console.error('   Confira: Configurações > Integrações > API (modo desenvolvedor) no RD CRM.');
    process.exit(1);
  }
  console.log('   ✓ token aceito');

  /* -------------------------- 2. Funil e etapa --------------------------- */
  console.log('\n2) Conferindo funil e etapa...');
  const funis = lista(teste.dados, 'deal_pipelines');
  const funil = funis.find((f) => (f._id || f.id) === PIPELINE);
  if (funil) console.log('   ✓ funil ' + PIPELINE + ' = "' + funil.name + '"');
  else {
    console.log('   ✗ funil ' + PIPELINE + ' não encontrado. Funis disponíveis:');
    funis.forEach((f) => console.log('       ' + (f._id || f.id) + '  ' + f.name));
  }

  const etapas = await get('/api/v1/deal_stages', { limit: '200' });
  const todas = lista(etapas.dados, 'deal_stages');
  const etapa = todas.find((e) => (e._id || e.id) === STAGE);
  if (etapa) {
    const funilDaEtapa = etapa.deal_pipeline_id
      || (etapa.deal_pipeline && (etapa.deal_pipeline._id || etapa.deal_pipeline.id))
      || '';
    console.log('   ✓ etapa ' + STAGE + ' = "' + etapa.name + '"');
    if (funilDaEtapa && funilDaEtapa !== PIPELINE) {
      console.log('   ⚠ ATENÇÃO: essa etapa pertence ao funil ' + funilDaEtapa + ', não ao ' + PIPELINE);
    } else if (funilDaEtapa) {
      console.log('   ✓ a etapa está no funil esperado');
    }
  } else {
    console.log('   ✗ etapa ' + STAGE + ' não encontrada. Etapas do funil ' + PIPELINE + ':');
    todas
      .filter((e) => (e.deal_pipeline_id || '') === PIPELINE)
      .forEach((e) => console.log('       ' + (e._id || e.id) + '  ' + e.name));
  }

  /* --------------------- 3. Campos personalizados ------------------------ */
  console.log('\n3) Conferindo os 10 campos personalizados...');
  const cf = await get('/api/v1/custom_fields', { limit: '200' });
  const campos = lista(cf.dados, 'custom_fields');
  const porId = new Map(campos.map((c) => [(c._id || c.id), c]));

  let problemas = 0;
  for (const esperado of ESPERADO) {
    const campo = porId.get(esperado.id);
    if (!campo) {
      problemas++;
      console.log('   ✗ ' + esperado.nome + ' (' + esperado.id + ') NÃO existe nesta conta');
      continue;
    }

    const rotulo = campo.label || campo.name || '(sem rótulo)';
    const alvo = campo.for || campo.presence_config || campo.type_of || '';
    const linha = '   ✓ ' + esperado.id + '  ' + rotulo + (alvo ? '  [' + alvo + ']' : '');
    console.log(linha);

    if (rotulo && rotulo.trim() !== esperado.nome) {
      console.log('       ⚠ rótulo diferente do mapeado no código: "' + esperado.nome + '"');
    }
    if (alvo && String(alvo).toLowerCase().indexOf('contact') > -1) {
      problemas++;
      console.log('       ✗ este campo é de CONTATO — não pode ir em deal_custom_fields');
    }

    // Compara as opções válidas, quando o campo é de seleção.
    const opcoesApi = (campo.options || campo.custom_field_options || [])
      .map((o) => (typeof o === 'string' ? o : (o.label || o.name || o.value)))
      .filter(Boolean);
    if (esperado.opcoes && opcoesApi.length) {
      const faltando = esperado.opcoes.filter((o) => opcoesApi.indexOf(o) === -1);
      if (faltando.length) {
        problemas++;
        console.log('       ✗ opções que o código envia e o CRM NÃO tem: ' + JSON.stringify(faltando));
        console.log('         opções reais no CRM: ' + JSON.stringify(opcoesApi));
      } else {
        console.log('       ✓ todas as opções mapeadas existem no CRM');
      }
    }
  }

  /* ------------------------------ resumo -------------------------------- */
  console.log('\n──────────────────────────────');
  if (problemas === 0) {
    console.log('  Tudo conferido. Pode rodar o teste ponta a ponta no formulário.');
  } else {
    console.log('  ' + problemas + ' ponto(s) para corrigir antes de subir para produção.');
  }
  process.exit(problemas ? 1 : 0);
})().catch((e) => {
  console.error('Erro inesperado:', e && e.message);
  process.exit(1);
});