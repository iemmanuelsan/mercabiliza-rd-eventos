/* =============================================================================
 *  MERCABILIZA — CAPTAÇÃO EM EVENTO  ➔  RD STATION CRM
 *  netlify/functions/evento-diagnostico.js
 *
 *  IRMÃ GÊMEA de pre-diagnostico.js, com três diferenças e nada mais:
 *    a) o card nasce com o prefixo do evento — "[Summit] RAZÃO SOCIAL";
 *    b) o campo [MB] Fonte/Origem recebe "Evento / Feira" em vez de
 *       "Inbound / Orgânico";
 *    c) a anotação abre dizendo que o lead foi captado no stand.
 *
 *  É um arquivo independente de propósito: o fluxo orgânico do site continua
 *  rodando sem risco, mesmo que algo precise ser mexido às pressas durante o
 *  evento. Para NÃO clonar de novo no próximo evento, o nome e a origem são
 *  parametrizáveis — por variável de ambiente ou pelo corpo da requisição
 *  (`origem_evento` e `fonte_origem`).
 *
 *  O QUE ESTA FUNÇÃO FAZ (nesta ordem):
 *    1. Recebe o POST do formulário (JSON) com o relatório bruto do
 *       pré-diagnóstico e, quando disponível, as respostas já estruturadas.
 *    2. Faz o parser/normalização dos dados (texto livre ➔ strings exatas
 *       exigidas pelos campos de seleção única do RD Station CRM).
 *    3. Garante idempotência do Contato: procura por e-mail (e, opcionalmente,
 *       por nome exato) antes de criar um novo.
 *    4. Cria a Negociação (deal) na etapa "Lead Orgânico - LO" do funil
 *       "Funil - Mercabiliza", com os campos personalizados mapeados.
 *    5. Cria a anotação (activity) com o texto integral do pré-diagnóstico.
 *    6. Sempre responde HTTP 200 com JSON — nunca trava o redirecionamento
 *       do usuário para o WhatsApp.
 *
 *  RUNTIME: Node 18+ na Netlify (usa o fetch nativo — zero dependências).
 * ========================================================================== */

'use strict';

/* =============================================================================
 *  1. CONFIGURAÇÃO E MAPEAMENTO
 * ========================================================================== */

/** Host da API do RD Station CRM (v1). */
const RD_HOST = 'https://crm.rdstation.com';

/**
 * Token do usuário do CRM.
 * Configure em: Netlify > Site settings > Environment variables > RD_CRM_TOKEN.
 * O fallback existe apenas para não quebrar um teste local esquecido — em
 * produção o valor SEMPRE deve vir da variável de ambiente.
 */
const RD_TOKEN = process.env.RD_CRM_TOKEN || '';

/** Funil de destino — usado só para conferência/log (o funil é inferido da etapa). */
const DEAL_PIPELINE_ID = process.env.RD_PIPELINE_ID || '68adf82967a7b0001b5cc9e0';

/**
 * Etapa inicial. Por padrão é a mesma do fluxo orgânico ("Lead Orgânico - LO"),
 * porque foi o combinado. Se um dia o evento merecer uma coluna própria, basta
 * criar a etapa no CRM e apontar RD_EVENTO_STAGE_ID para ela — sem tocar aqui.
 */
const DEAL_STAGE_ID = process.env.RD_EVENTO_STAGE_ID
  || process.env.RD_STAGE_ID
  || '6a70e1f68b8c0f00261e6af9';

/* -----------------------------------------------------------------------------
 *  IDENTIDADE DO EVENTO
 *
 *  EVENTO_PADRAO
 *    Nome que vira o prefixo do card e aparece na anotação. Pode ser trocado
 *    sem deploy pela variável de ambiente EVENTO_NOME e, por requisição, pelo
 *    campo `origem_evento` do corpo do POST (é assim que o mesmo endpoint
 *    atende o próximo evento sem virar um terceiro arquivo).
 *
 *  FONTE_ORIGEM_EVENTO
 *    Valor gravado no campo [MB] Fonte/Origem. ATENÇÃO: é um campo de seleção
 *    única — o texto precisa existir, letra por letra, na lista de opções do
 *    RD Station CRM, senão o campo chega vazio. Confira com:
 *        RD_CRM_TOKEN=... node scripts/rd-crm-check.js
 * -------------------------------------------------------------------------- */
const EVENTO_PADRAO       = process.env.EVENTO_NOME || 'Summit';
const FONTE_ORIGEM_EVENTO = process.env.EVENTO_FONTE_ORIGEM || 'Evento / Feira';

/** Tamanho máximo do prefixo, para um nome de evento gigante não comer o título. */
const MAX_PREFIXO = 40;

/** IDs dos campos personalizados da NEGOCIAÇÃO (deal_custom_fields). */
const CF = {
  CIDADE:            '67323f79974b87001de29ac5', // Cidade — texto livre
  ESTADO:            '67323fbb39b27d0013037211', // Estado — sigla
  STATUS_CNPJ:       '6a88a6d962254a0024d72f8c', // [MB] Status CNPJ — seleção única
  NUMERO_CNPJ:       '69e0dcedac010300134dfaa8', // Número do CNPJ — texto formatado
  QTD_LOJAS:         '6a8c3e7db55120002f55c759', // [MB] Quantidade de Lojas — seleção única
  MODELO_REDE:       '6a8c3ef5906ac80025b0cf51', // [MB] Modelo de Rede — seleção única
  FRANQUIA:          '67d9c07b0e56fe001b6f6217', // Franquia — texto livre
  SISTEMA_GESTAO:    '6a8f2b852843650025bc2706', // [MB] Sistema de Gestão (ERP/PDV) — texto
  STATUS_OPERACIONAL:'6a8f287ac63bbc002ad43597', // [MB] Status Operacional — seleção única
  FONTE_ORIGEM:      '6a88a5816caedd0020878de8', // [MB] Fonte/Origem — seleção única
};

/** Valores válidos dos campos de seleção única (grafia EXATA exigida pelo CRM). */
const OPCOES = {
  STATUS_CNPJ: {
    ATIVO:    'Ativo',
    INATIVO:  'Inativo / Baixado',
    SEM_CNPJ: 'Não Possui (PF)',
  },
  QTD_LOJAS: {
    UMA:      '1 Loja (Matriz Única)',
    DE_2_A_5: '2 a 5 Lojas',
    DE_6_A_15:'6 a 15 Lojas',
    DE_16_A_50:'16 a 50 Lojas',
    MAIS_50:  '+ 50 Lojas',
  },
  MODELO_REDE: {
    PROPRIA:  'Operação Própria (OpP)',
    FRANQUIA: 'Franquia / Franqueado',
  },
  STATUS_OPERACIONAL: {
    NORMAL:   'Em Operação Normal',
  },
  FONTE_ORIGEM: {
    INBOUND: 'Inbound / Orgânico',  // usado pelo fluxo do site
    EVENTO:  'Evento / Feira',      // usado aqui — precisa existir no CRM
  },
};

/**
 * Regras de comportamento (ajustáveis por variável de ambiente).
 *
 * VINCULAR_CONTATO_POR_ID
 *   true  → o payload da negociação envia contacts: [{ _id: <contact_id> }].
 *           Se a API recusar esse formato, a função reenvia automaticamente
 *           usando os dados de identificação (nome + e-mail).
 *
 * DEDUPE_POR_NOME
 *   true  → quando o lead NÃO informa e-mail (campo opcional no formulário),
 *           tenta reaproveitar um contato existente cujo nome completo seja
 *           idêntico E que seja o único resultado da busca. Evita duplicatas
 *           sem correr o risco de "colar" o card em um homônimo qualquer.
 *
 * TIMEOUT_MS
 *   Tempo máximo de cada chamada HTTP ao CRM.
 */
const VINCULAR_CONTATO_POR_ID = process.env.RD_VINCULAR_POR_ID !== 'false';
const DEDUPE_POR_NOME         = process.env.RD_DEDUPE_POR_NOME !== 'false';
const TIMEOUT_MS              = Number(process.env.RD_TIMEOUT_MS || 9000);

/**
 * EMPRESA (organização) no CRM.
 *
 * CRIAR_ORGANIZACAO
 *   true → quando há razão social (ou CNPJ), procura a empresa pelo nome e,
 *          se não existir, cria. O card e o contato ficam amarrados a ela.
 *
 * ORG_CF_CNPJ
 *   ID de um campo personalizado de EMPRESA para gravar o CNPJ. Se a sua conta
 *   ainda não tem esse campo, deixe em branco: o CNPJ vai para o "resumo" da
 *   empresa (só na criação — nunca sobrescrevemos o resumo de uma já existente).
 *
 * TIPO_TELEFONE
 *   Rótulo do telefone no contato ("Comercial", "Celular"...). Em branco, o CRM
 *   aplica o padrão dele — é o mais seguro, porque a lista de tipos válidos
 *   varia por conta.
 */
const CRIAR_ORGANIZACAO = process.env.RD_CRIAR_ORGANIZACAO !== 'false';
const ORG_CF_CNPJ       = process.env.RD_ORG_CF_CNPJ || '';
const TIPO_TELEFONE     = process.env.RD_TIPO_TELEFONE || '';

/** Tamanho máximo do texto da anotação (proteção contra payload gigante). */
const MAX_TEXTO_ANOTACAO = 12000;

/** Cabeçalhos CORS — o formulário é same-origin, mas isto libera testes e embeds. */
const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': process.env.RD_ALLOW_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

/* =============================================================================
 *  2. UTILITÁRIOS DE TEXTO
 * ========================================================================== */

/** Remove acentos e baixa a caixa — usado para comparar rótulos e opções. */
function chave(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove os diacriticos separados pelo NFD
    .toLowerCase()
    .trim();
}

/** Colapsa espaços e remove marcadores de negrito/itálico do WhatsApp. */
function limpo(s) {
  return String(s == null ? '' : s)
    .replace(/[*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Só os dígitos de uma string (CNPJ, telefone). */
function digitos(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

/** Formata 14 dígitos como 00.000.000/0000-00. Devolve '' se não houver 14. */
function formatarCnpj(valor) {
  const d = digitos(valor);
  if (d.length !== 14) return '';
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

/** Valida CNPJ pelos dois dígitos verificadores. */
function cnpjValido(valor) {
  const c = digitos(valor);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (base) => {
    const pesos = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += parseInt(base[i], 10) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(c.slice(0, 12));
  const d2 = calc(c.slice(0, 12) + d1);
  return c === c.slice(0, 12) + String(d1) + String(d2);
}

/**
 * Formata um telefone brasileiro para gravar no CRM.
 * Aceita "5519998887777", "19998887777", "(19) 99888-7777" e devolve
 * "(19) 99888-7777". Números fora do padrão BR voltam como "+<dígitos>".
 */
function formatarTelefoneBr(valor) {
  let d = digitos(valor);
  if (!d) return '';
  // Remove o DDI 55 quando o número tem o tamanho de um telefone nacional.
  if (d.length > 11 && d.slice(0, 2) === '55') d = d.slice(2);
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
  if (d.length === 9 || d.length === 8) return d; // sem DDD: grava como veio
  return '+' + d;
}

/** Monta o objeto de telefone aceito pelo CRM (com ou sem rótulo de tipo). */
function objetoTelefone(valor) {
  const numero = formatarTelefoneBr(valor);
  if (!numero) return null;
  const obj = { phone: numero };
  if (TIPO_TELEFONE) obj.type = TIPO_TELEFONE;
  return obj;
}

/** Lista de UFs válidas — usada para separar "Cidade / UF". */
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
             'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

/**
 * Separa "Campinas / SP", "Campinas - SP", "Campinas (SP)" ou "Campinas SP"
 * em { cidade: 'Campinas', uf: 'SP' }. Se não achar UF, devolve uf: ''.
 */
function separarCidadeUf(texto) {
  const t = limpo(texto);
  if (!t) return { cidade: '', uf: '' };

  // Formatos com separador explícito: "/", "-", "–", ",", "(" ... ")"
  let m = t.match(/^(.*?)\s*[\/\-–,]\s*([A-Za-z]{2})\s*$/);
  if (m && UFS.indexOf(m[2].toUpperCase()) > -1) {
    return { cidade: limpo(m[1]), uf: m[2].toUpperCase() };
  }
  m = t.match(/^(.*?)\s*\(\s*([A-Za-z]{2})\s*\)\s*$/);
  if (m && UFS.indexOf(m[2].toUpperCase()) > -1) {
    return { cidade: limpo(m[1]), uf: m[2].toUpperCase() };
  }
  // Formato sem separador: "Campinas SP"
  m = t.match(/^(.*?)\s+([A-Za-z]{2})\s*$/);
  if (m && UFS.indexOf(m[2].toUpperCase()) > -1) {
    return { cidade: limpo(m[1]), uf: m[2].toUpperCase() };
  }
  // Só a UF foi informada
  if (UFS.indexOf(t.toUpperCase()) > -1) return { cidade: '', uf: t.toUpperCase() };

  return { cidade: t, uf: '' };
}

/* =============================================================================
 *  3. PARSER DO RELATÓRIO BRUTO
 *
 *  O formulário envia o texto exatamente como vai para o WhatsApp, no formato:
 *
 *    *PRÉ-DIAGNÓSTICO MERCABILIZA*
 *    ───────────────
 *    *Nome:* João da Silva
 *    *Cidade:* Sorocaba / SP
 *    *E-mail:* joao@empresa.com.br
 *    *Quantidade de lojas:* 6 lojas
 *    *CNPJ:* 51.491.291/0001-07
 *       _MERCABILIZA CONTABILIDADE LTDA_
 *       _Situação: ATIVA_
 *    ───────────────
 *    Consultor: Rafael
 *    Respondido em 02/09/2026 10:31:00
 *
 *  O parser abaixo transforma isso em um objeto plano. Ele é usado tanto como
 *  fonte principal (quando o front-end só manda "message") quanto como
 *  complemento do array estruturado "respostas".
 * ========================================================================== */

/** Mapa rótulo-do-resumo ➔ chave canônica interna. */
const ROTULOS = {
  'nome': 'nome',
  'cidade': 'cidade',
  'cidade e estado': 'cidade',
  'e-mail': 'email',
  'email': 'email',
  'telefone': 'telefone',
  'whatsapp': 'telefone',
  'ja tem minimercado': 'temLoja',
  'tipo de operacao': 'operacao',
  'franquia / licenca': 'franquia',
  'franquia': 'franquia',
  'quantidade de lojas': 'qtdLojas',
  'faturamento mensal (total)': 'faturamento',
  'faturamento': 'faturamento',
  'sistema de gestao': 'sistema',
  'emite nfc-e': 'nfce',
  'onde ficam as lojas': 'local',
  'onde ficarao as lojas': 'local',
  'fase atual': 'fase',
  'prazo para operar': 'prazo',
  'prioridade': 'prioridade',
  'empresa aberta': 'temEmpresa',
  'regime tributario': 'regime',
  'cnpj': 'cnpj',
  'outros cnpjs': 'outrosCnpjs',
  'ja tem contador': 'temContador',
  'razao social': 'razaoSocial',
  'consultor': 'consultor',
};

/**
 * Converte o relatório bruto em { nome, cidade, email, cnpj, razaoSocial, ... }.
 * Trabalha linha a linha e é tolerante a variações de espaçamento/acentuação.
 */
function parsearRelatorio(texto) {
  const dados = {};
  if (!texto) return dados;

  const linhas = String(texto).split(/\r?\n/);
  let ultimaChave = '';

  for (const linhaBruta of linhas) {
    const linha = linhaBruta.trim();
    if (!linha) continue;

    // Linha de campo: "*Rótulo:* valor"  ou  "Rótulo: valor"
    const campo = linha.match(/^\*?\s*([^:*]{2,60}?)\s*:\s*\*?\s*(.*)$/);
    if (campo) {
      // limpo() antes de chave() para tirar os marcadores * e _ do rótulo,
      // porque as sub-linhas da Receita chegam como "_Situação: ATIVA_".
      const rotulo = chave(limpo(campo[1]));
      const valor  = limpo(campo[2]);

      // Sub-linhas em itálico vindas da consulta à Receita
      if (rotulo === 'situacao')  { dados.situacaoCnpj = valor; ultimaChave = 'situacaoCnpj'; continue; }
      if (rotulo === 'aberta em') { dados.aberturaCnpj = valor; ultimaChave = 'aberturaCnpj'; continue; }
      if (rotulo === 'atividade') { dados.atividadeCnpj = valor; ultimaChave = 'atividadeCnpj'; continue; }
      if (rotulo === 'nome fantasia') { dados.nomeFantasia = valor; ultimaChave = 'nomeFantasia'; continue; }
      if (rotulo === 'municipio') { dados.municipioCnpj = valor; ultimaChave = 'municipioCnpj'; continue; }

      const canonica = ROTULOS[rotulo];
      if (canonica) {
        // Não sobrescreve um valor já capturado (a primeira ocorrência vence).
        if (!dados[canonica]) dados[canonica] = valor;
        ultimaChave = canonica;
        continue;
      }
      // Rótulo desconhecido: guarda em "extras" para não perder informação.
      dados.extras = dados.extras || {};
      if (!dados.extras[limpo(campo[1])]) dados.extras[limpo(campo[1])] = valor;
      ultimaChave = '';
      continue;
    }

    // Linha em itálico logo abaixo do CNPJ = Razão Social devolvida pela Receita.
    const italico = linha.match(/^_(.+)_$/);
    if (italico && ultimaChave === 'cnpj' && !dados.razaoSocial) {
      dados.razaoSocial = limpo(italico[1]);
      continue;
    }
  }

  return dados;
}

/**
 * Achata o array "respostas" (que o front-end monta em coletar()) no mesmo
 * formato do parser. Esta é a fonte MAIS CONFIÁVEL, porque vem dos campos
 * reais do formulário, sem passar por texto.
 */
function achatarRespostas(respostas) {
  const dados = {};
  if (!Array.isArray(respostas)) return dados;

  // Nome do campo no HTML ➔ chave canônica interna.
  const porCampo = {
    nome: 'nome',
    cidade: 'cidade',
    email: 'email',
    temLoja: 'temLoja',
    operacao: 'operacao',
    operacaoFuturo: 'operacao',
    franquiaQual: 'franquia',
    franquiaQualFuturo: 'franquia',
    qtdLojas: 'qtdLojas',
    faturamento: 'faturamento',
    sistema: 'sistema',
    nfce: 'nfce',
    localAtual: 'local',
    localFuturo: 'local',
    fase: 'fase',
    prazoOperar: 'prazo',
    prioridade: 'prioridade',
    temEmpresa: 'temEmpresa',
    regime: 'regime',
    cnpj: 'cnpj',
    cnpjNaoSei: 'cnpjNaoSei',
    outrosCnpjs: 'outrosCnpjs',
    temContador: 'temContador',
  };

  for (const item of respostas) {
    if (!item || !item.campo) continue;
    const canonica = porCampo[item.campo];
    const valor = limpo(item.valor);
    if (!canonica || !valor) continue;
    if (!dados[canonica]) dados[canonica] = valor;
  }
  return dados;
}

/* =============================================================================
 *  4. NORMALIZADORES DE OPÇÃO
 *  Convertem o texto do formulário nas strings EXATAS dos campos de
 *  seleção única do RD Station CRM.
 * ========================================================================== */

/**
 * "1 loja" / "6 lojas" / "+15 lojas" / "20" ➔ faixa do CRM.
 *
 * Observação importante sobre o slider: hoje ele vai de 1 a 15 e o topo é
 * exibido como "+15 lojas", ou seja, "15 ou mais". Tratamos esse topo como
 * "16 a 50 Lojas", porque o "+" indica que passou de 15. Se você aumentar o
 * range do slider no HTML, este normalizador continua funcionando: ele lê o
 * número e escolhe a faixa.
 */
function normalizarQtdLojas(texto) {
  const t = chave(texto);
  if (!t) return '';

  const temMais = /\+|mais de|acima de/.test(t);
  const numeros = t.match(/\d+/g);
  if (!numeros) {
    // Textos sem número: tenta pelo enunciado.
    if (/matriz unica|uma loja|unica loja/.test(t)) return OPCOES.QTD_LOJAS.UMA;
    return '';
  }

  // Se o texto já for uma faixa ("2 a 5 lojas"), usa o maior número dela.
  let n = Math.max.apply(null, numeros.map(Number));
  if (temMais) n = n + 1; // "+15" ➔ trata como 16 (primeira faixa acima)

  if (n <= 1)  return OPCOES.QTD_LOJAS.UMA;
  if (n <= 5)  return OPCOES.QTD_LOJAS.DE_2_A_5;
  if (n <= 15) return OPCOES.QTD_LOJAS.DE_6_A_15;
  if (n <= 50) return OPCOES.QTD_LOJAS.DE_16_A_50;
  return OPCOES.QTD_LOJAS.MAIS_50;
}

/** "Operação própria" / "Franquia ou licença" ➔ opção do campo Modelo de Rede. */
function normalizarModeloRede(textoOperacao, nomeFranquia) {
  const t = chave(textoOperacao);
  if (/franquia|franqueado|licenc/.test(t)) return OPCOES.MODELO_REDE.FRANQUIA;
  if (/propri/.test(t)) return OPCOES.MODELO_REDE.PROPRIA;
  // "Ainda não defini": se informou o nome de uma rede, assume franquia.
  if (limpo(nomeFranquia)) return OPCOES.MODELO_REDE.FRANQUIA;
  return ''; // indefinido ➔ não envia o campo
}

/**
 * Decide o [MB] Status CNPJ combinando:
 *   - se o lead disse que tem empresa aberta;
 *   - a situação cadastral devolvida pela Receita (quando houver);
 *   - a existência de um CNPJ válido digitado.
 */
function normalizarStatusCnpj(dados, receita) {
  const temEmpresa = chave(dados.temEmpresa);
  const situacao   = chave((receita && receita.situacao) || dados.situacaoCnpj || '');

  // Declarou que NÃO tem empresa aberta ➔ pessoa física.
  if (/^nao/.test(temEmpresa) || /nao tem empresa/.test(temEmpresa)) {
    return OPCOES.STATUS_CNPJ.SEM_CNPJ;
  }

  if (situacao) {
    if (/ativ/.test(situacao)) return OPCOES.STATUS_CNPJ.ATIVO;
    if (/baixad|inapt|suspens|nula|inativ/.test(situacao)) return OPCOES.STATUS_CNPJ.INATIVO;
  }

  // Sem retorno da Receita: se há CNPJ válido, considera ativo; senão, deixa
  // em branco (não chuta "Não Possui" para quem afirmou ter empresa).
  if (cnpjValido(dados.cnpj)) return OPCOES.STATUS_CNPJ.ATIVO;
  if (/^sim/.test(temEmpresa) || /tem cnpj/.test(temEmpresa)) return '';
  return '';
}

/** "AMLabs" / "Outro" / "Não possuo" ➔ texto do campo Sistema de Gestão. */
function normalizarSistema(texto) {
  const t = chave(texto);
  if (!t) return '';
  if (/amlabs|am labs/.test(t)) return 'AMLabs';
  if (/nao poss|nenhum|nao tenho|nao usa/.test(t)) return 'Não possui';
  if (/^outro/.test(t)) return 'Outro (não informado)';
  return limpo(texto); // já veio o nome do ERP
}

/**
 * [MB] Status Operacional. O único valor válido informado é
 * "Em Operação Normal", então só preenchemos quando o lead JÁ opera.
 * Para quem ainda não abriu, o campo fica vazio (a fase vai na anotação).
 */
function normalizarStatusOperacional(dados) {
  const t = chave(dados.temLoja);
  if (/^sim/.test(t) || /ja opera/.test(t)) return OPCOES.STATUS_OPERACIONAL.NORMAL;
  return '';
}

/* =============================================================================
 *  5. CLIENTE HTTP DO RD STATION CRM
 * ========================================================================== */

/**
 * Executa uma chamada à API do CRM.
 * Sempre devolve um objeto — nunca lança — para que o fluxo continue.
 *
 * @param {string} caminho  ex.: '/api/v1/deals'
 * @param {object} opcoes   { metodo, query, corpo }
 * @returns {Promise<{ok:boolean,status:number,dados:any,erro:string}>}
 */
async function chamarRd(caminho, opcoes) {
  const cfg = opcoes || {};
  const query = new URLSearchParams(Object.assign({ token: RD_TOKEN }, cfg.query || {}));
  const url = RD_HOST + caminho + '?' + query.toString();

  const init = {
    method: cfg.metodo || 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (cfg.corpo !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(cfg.corpo);
  }

  try {
    const resposta = await fetch(url, init);
    const bruto = await resposta.text();
    let dados = null;
    if (bruto) {
      try { dados = JSON.parse(bruto); } catch (_e) { dados = { raw: bruto }; }
    }
    if (!resposta.ok) {
      console.error('[RD CRM] %s %s ➔ HTTP %s | %s',
        init.method, caminho, resposta.status, bruto.slice(0, 500));
    }
    return {
      ok: resposta.ok,
      status: resposta.status,
      dados: dados,
      erro: resposta.ok ? '' : ('HTTP ' + resposta.status + ' ' + bruto.slice(0, 300)),
    };
  } catch (e) {
    console.error('[RD CRM] falha de rede em %s %s: %s', init.method, caminho, e && e.message);
    return { ok: false, status: 0, dados: null, erro: String((e && e.message) || e) };
  }
}

/* ------------------------- 5.1 Contato (idempotência) --------------------- */

/** Busca um contato pelo e-mail exato. Devolve o objeto do contato ou null. */
async function buscarContatoPorEmail(email) {
  if (!email) return null;
  const r = await chamarRd('/api/v1/contacts', { query: { email: email, limit: '20' } });
  if (!r.ok || !r.dados) return null;

  const lista = Array.isArray(r.dados) ? r.dados : (r.dados.contacts || []);
  const alvo = chave(email);

  for (const c of lista) {
    const emails = c && Array.isArray(c.emails) ? c.emails : [];
    if (emails.some((e) => chave(e && e.email) === alvo)) return c;
  }
  // Alguns retornos da API já vêm filtrados: se houver exatamente um, aceita.
  return lista.length === 1 ? lista[0] : null;
}

/**
 * Fallback de idempotência para leads sem e-mail: reaproveita o contato apenas
 * quando o nome completo é idêntico E há um único resultado — assim não
 * corremos o risco de anexar a negociação ao contato de um homônimo.
 */
async function buscarContatoPorNome(nome) {
  if (!DEDUPE_POR_NOME || !nome || limpo(nome).length < 5) return null;
  const r = await chamarRd('/api/v1/contacts', { query: { q: limpo(nome), limit: '20' } });
  if (!r.ok || !r.dados) return null;

  const lista = Array.isArray(r.dados) ? r.dados : (r.dados.contacts || []);
  const iguais = lista.filter((c) => chave(c && c.name) === chave(nome));
  return iguais.length === 1 ? iguais[0] : null;
}

/** Cria o contato. Devolve o objeto criado ou null. */
async function criarContato(dados, organizacaoId) {
  const contato = { name: limpo(dados.nome) || 'Lead sem nome (Pré-Diagnóstico)' };
  if (dados.email) contato.emails = [{ email: limpo(dados.email) }];

  const telefone = objetoTelefone(dados.telefone);
  if (telefone) contato.phones = [telefone];

  if (organizacaoId) contato.organization_id = organizacaoId;

  const r = await chamarRd('/api/v1/contacts', { metodo: 'POST', corpo: { contact: contato } });
  if (!r.ok) return null;
  return r.dados || null;
}

/**
 * Completa um contato JÁ existente com o que ele ainda não tem: telefone
 * (que agora chega pelo link do consultor) e empresa. Nunca sobrescreve
 * um dado preenchido — só preenche lacuna. Falhas aqui são irrelevantes
 * para o fluxo, então são apenas logadas.
 */
async function completarContato(contato, dados, organizacaoId) {
  if (!contato) return false;
  const id = contato._id || contato.id;
  if (!id) return false;

  const alteracoes = {};

  // Telefone: só entra se o contato não tiver nenhum.
  const jaTemTelefone = Array.isArray(contato.phones) && contato.phones.length > 0;
  const telefone = objetoTelefone(dados.telefone);
  if (!jaTemTelefone && telefone) alteracoes.phones = [telefone];

  // Empresa: só entra se o contato estiver sem empresa.
  const orgAtual = contato.organization_id
    || (contato.organization && (contato.organization._id || contato.organization.id))
    || '';
  if (!orgAtual && organizacaoId) alteracoes.organization_id = organizacaoId;

  if (!Object.keys(alteracoes).length) return false;

  const r = await chamarRd('/api/v1/contacts/' + id, {
    metodo: 'PUT',
    corpo: { contact: alteracoes },
  });
  if (r.ok) console.log('[RD CRM] contato %s completado: %s', id, Object.keys(alteracoes).join(', '));
  else console.warn('[RD CRM] não foi possível completar o contato %s: %s', id, r.erro);
  return r.ok;
}

/**
 * Garante um contato no CRM e devolve { id, criado, contato }.
 * Ordem: e-mail ➔ nome exato ➔ criação.
 */
async function garantirContato(dados, organizacaoId) {
  let contato = await buscarContatoPorEmail(dados.email);
  if (contato) {
    console.log('[RD CRM] contato reaproveitado por e-mail: %s', contato._id || contato.id);
    await completarContato(contato, dados, organizacaoId);
    return { id: contato._id || contato.id, criado: false, contato: contato };
  }

  if (!dados.email) {
    contato = await buscarContatoPorNome(dados.nome);
    if (contato) {
      console.log('[RD CRM] contato reaproveitado por nome exato: %s', contato._id || contato.id);
      await completarContato(contato, dados, organizacaoId);
      return { id: contato._id || contato.id, criado: false, contato: contato };
    }
  }

  contato = await criarContato(dados, organizacaoId);
  if (contato) {
    console.log('[RD CRM] contato criado: %s', contato._id || contato.id);
    return { id: contato._id || contato.id, criado: true, contato: contato };
  }
  return { id: '', criado: false, contato: null };
}

/* --------------------------- 5.1b Empresa (organização) ------------------- */

/** Nome da empresa: razão social da Receita ➔ o que o lead digitou ➔ vazio. */
function nomeDaEmpresa(dados, receita) {
  return limpo((receita && receita.razao) || dados.razaoSocial || '');
}

/** Procura a empresa pelo nome exato (a busca do CRM é por aproximação). */
async function buscarOrganizacaoPorNome(nome) {
  if (!nome) return null;
  const r = await chamarRd('/api/v1/organizations', { query: { q: nome, limit: '50' } });
  if (!r.ok || !r.dados) return null;

  const lista = Array.isArray(r.dados) ? r.dados : (r.dados.organizations || []);
  const exatas = lista.filter((o) => chave(o && o.name) === chave(nome));
  if (exatas.length) return exatas[0];
  return null;
}

/** Cria a empresa com o CNPJ no campo personalizado (ou no resumo). */
async function criarOrganizacao(nome, dados, receita, contexto) {
  const evento = limpo((contexto || {}).evento) || EVENTO_PADRAO;
  const organizacao = { name: nome };
  const cnpj = formatarCnpj(dados.cnpj);

  if (cnpj && ORG_CF_CNPJ) {
    organizacao.organization_custom_fields = [{ custom_field_id: ORG_CF_CNPJ, value: cnpj }];
  }

  // Resumo só na criação — jamais mexemos no resumo de uma empresa existente.
  const resumo = [];
  if (cnpj) resumo.push('CNPJ: ' + cnpj);
  if (receita && receita.atividade) resumo.push('Atividade: ' + limpo(receita.atividade));
  if (receita && receita.municipio) resumo.push('Município: ' + limpo(receita.municipio));
  resumo.push('Cadastrada no stand da Mercabiliza durante o ' + evento + '.');
  organizacao.resume = resumo.join(' | ').slice(0, 500);

  const r = await chamarRd('/api/v1/organizations', {
    metodo: 'POST',
    corpo: { organization: organizacao },
  });
  if (!r.ok) return null;
  return r.dados || null;
}

/**
 * Garante a empresa no CRM e devolve { id, criada, nome }.
 * Sem razão social não cria nada: uma empresa com o nome de uma pessoa
 * física só suja a base.
 */
async function garantirOrganizacao(dados, receita, contexto) {
  if (!CRIAR_ORGANIZACAO) return { id: '', criada: false, nome: '' };

  const nome = nomeDaEmpresa(dados, receita);
  if (!nome) return { id: '', criada: false, nome: '' };

  const existente = await buscarOrganizacaoPorNome(nome);
  if (existente) {
    const id = existente._id || existente.id;
    console.log('[RD CRM] empresa reaproveitada: %s (%s)', id, nome);
    return { id: id, criada: false, nome: nome };
  }

  const nova = await criarOrganizacao(nome, dados, receita, contexto);
  if (nova) {
    const id = nova._id || nova.id;
    console.log('[RD CRM] empresa criada: %s (%s)', id, nome);
    return { id: id, criada: true, nome: nome };
  }

  console.warn('[RD CRM] não foi possível criar a empresa "%s" — seguindo sem ela.', nome);
  return { id: '', criada: false, nome: nome };
}

/* --------------------------- 5.2 Campos e negociação ---------------------- */

/**
 * Monta o array deal_custom_fields, ignorando valores vazios (o CRM recusa
 * string vazia em campos de seleção única).
 */
function montarCamposPersonalizados(dados, receita, contexto) {
  const ctx = contexto || {};
  const cidadeUf = separarCidadeUf(dados.cidade);

  // Se a Receita devolveu o município, ele tem prioridade sobre o digitado.
  let cidade = cidadeUf.cidade;
  let uf     = cidadeUf.uf;
  const municipioReceita = (receita && receita.municipio) || dados.municipioCnpj || '';
  if (municipioReceita) {
    const m = separarCidadeUf(municipioReceita);
    if (m.cidade) cidade = m.cidade;
    if (m.uf)     uf = m.uf;
  }

  const pares = [
    [CF.CIDADE,             cidade],
    [CF.ESTADO,             uf],
    [CF.STATUS_CNPJ,        normalizarStatusCnpj(dados, receita)],
    [CF.NUMERO_CNPJ,        formatarCnpj(dados.cnpj)],
    [CF.QTD_LOJAS,          normalizarQtdLojas(dados.qtdLojas)],
    [CF.MODELO_REDE,        normalizarModeloRede(dados.operacao, dados.franquia)],
    [CF.FRANQUIA,           limpo(dados.franquia)],
    [CF.SISTEMA_GESTAO,     normalizarSistema(dados.sistema)],
    [CF.STATUS_OPERACIONAL, normalizarStatusOperacional(dados)],
    // Única diferença de mapeamento em relação ao fluxo orgânico:
    [CF.FONTE_ORIGEM,       ctx.fonteOrigem || FONTE_ORIGEM_EVENTO],
  ];

  return pares
    .filter(([id, valor]) => id && valor !== '' && valor != null)
    .map(([id, valor]) => ({ custom_field_id: id, value: valor }));
}

/**
 * Título do card: "[Summit] Razão Social" (ou o nome do lead).
 * O prefixo vem do evento em curso, então o mesmo endpoint serve para
 * "[Summit]", "[APAS]", "[Feira X]" — é só mudar EVENTO_NOME ou mandar
 * `origem_evento` no corpo da requisição.
 */
function montarTitulo(dados, receita, contexto) {
  const ctx = contexto || {};
  const razao = limpo((receita && receita.razao) || dados.razaoSocial || '');
  const base  = razao || limpo(dados.nome) || 'Lead sem identificação';
  const evento = (limpo(ctx.evento) || EVENTO_PADRAO).slice(0, MAX_PREFIXO);
  return ('[' + evento + '] ' + base).slice(0, 120);
}

/**
 * Cria a negociação. Tenta primeiro vincular o contato por _id; se a API
 * recusar (4xx), reenvia identificando o contato por nome/e-mail — o CRM
 * deduplica por e-mail, então o card cai no contato certo de qualquer forma.
 */
async function criarNegociacao(dados, receita, contatoId, organizacaoId, contexto) {
  const deal = {
    name: montarTitulo(dados, receita, contexto),
    deal_stage_id: DEAL_STAGE_ID,
    deal_custom_fields: montarCamposPersonalizados(dados, receita, contexto),
  };

  /** Base do payload, com a empresa vinculada quando existe. */
  const comOrganizacao = (extra) => {
    const corpo = Object.assign({ deal: deal }, extra);
    if (organizacaoId) corpo.organization = { _id: organizacaoId };
    return corpo;
  };

  const contatoPorIdentificacao = {
    name: limpo(dados.nome) || 'Lead sem nome (Pré-Diagnóstico)',
  };
  if (dados.email) contatoPorIdentificacao.emails = [{ email: limpo(dados.email) }];
  const telefone = objetoTelefone(dados.telefone);
  if (telefone) contatoPorIdentificacao.phones = [telefone];

  // Tentativa 1 — vínculo por ID (evita qualquer chance de duplicar contato).
  if (VINCULAR_CONTATO_POR_ID && contatoId) {
    const r1 = await chamarRd('/api/v1/deals', {
      metodo: 'POST',
      corpo: comOrganizacao({ contacts: [{ _id: contatoId }] }),
    });
    if (r1.ok && r1.dados) return { ok: true, deal: r1.dados, tentativa: 'contato_por_id' };
    console.warn('[RD CRM] vínculo por _id recusado (%s). Reenviando por identificação.', r1.status);
  }

  // Tentativa 2 — vínculo pelos dados de identificação do contato.
  const r2 = await chamarRd('/api/v1/deals', {
    metodo: 'POST',
    corpo: comOrganizacao({ contacts: [contatoPorIdentificacao] }),
  });
  if (r2.ok && r2.dados) return { ok: true, deal: r2.dados, tentativa: 'contato_por_identificacao' };

  // Tentativa 3 — negociação sem contato, para não perder o lead.
  const r3 = await chamarRd('/api/v1/deals', { metodo: 'POST', corpo: comOrganizacao({}) });
  if (r3.ok && r3.dados) return { ok: true, deal: r3.dados, tentativa: 'sem_contato', aviso: r2.erro };

  return { ok: false, deal: null, erro: r3.erro || r2.erro };
}

/* ------------------------------ 5.3 Anotação ------------------------------ */

/** Monta o texto da anotação: cabeçalho de rastreio + relatório integral. */
function montarTextoAnotacao(entrada, dados, receita, contexto) {
  const ctx = contexto || {};
  const evento = limpo(ctx.evento) || EVENTO_PADRAO;

  const partes = [];
  // Cabeçalho que deixa claro, na primeira linha do histórico, que este lead
  // não veio do site: ele foi captado presencialmente.
  partes.push('LEAD CAPTADO PRESENCIALMENTE — STAND DO ' + evento.toUpperCase());
  partes.push('Diagnóstico preenchido no stand da Mercabiliza durante o ' + evento + '.');

  const meta = [];
  meta.push('Evento: ' + evento);
  if (entrada.consultor || dados.consultor) meta.push('Atendido por: ' + limpo(entrada.consultor || dados.consultor));
  if (dados.email)    meta.push('E-mail: ' + limpo(dados.email));
  if (dados.telefone) meta.push('Telefone: ' + formatarTelefoneBr(dados.telefone));
  if (entrada.origemUrl) meta.push('Origem: ' + limpo(entrada.origemUrl));
  meta.push('Recebido em: ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }));
  if (meta.length) partes.push(meta.join(' | '));

  partes.push('────────────────────────────');

  // Relatório integral, sem os marcadores de formatação do WhatsApp.
  const relatorio = limparRelatorioParaCrm(entrada.message);
  if (relatorio) {
    partes.push(relatorio);
  } else if (Array.isArray(entrada.respostas)) {
    // Sem "message": remonta a partir das respostas estruturadas.
    partes.push(entrada.respostas
      .filter((i) => i && i.valor)
      .map((i) => (i.rotulo || i.campo) + ': ' + limpo(i.valor))
      .join('\n'));
  }

  // Dados da Receita Federal, quando a consulta funcionou no navegador.
  if (receita && (receita.razao || receita.situacao)) {
    partes.push('────────────────────────────');
    partes.push('DADOS DA RECEITA FEDERAL');
    const r = [];
    if (receita.razao)     r.push('Razão social: ' + limpo(receita.razao));
    if (receita.fantasia)  r.push('Nome fantasia: ' + limpo(receita.fantasia));
    if (receita.situacao)  r.push('Situação cadastral: ' + limpo(receita.situacao));
    if (receita.abertura)  r.push('Aberta em: ' + limpo(receita.abertura));
    if (receita.atividade) r.push('Atividade principal: ' + limpo(receita.atividade));
    if (receita.porte)     r.push('Porte: ' + limpo(receita.porte));
    if (receita.municipio) r.push('Município: ' + limpo(receita.municipio));
    if (receita.simples)   r.push('Simples Nacional: ' + limpo(receita.simples));
    if (receita.mei)       r.push('MEI: ' + limpo(receita.mei));
    partes.push(r.join('\n'));
  }

  return partes.join('\n').slice(0, MAX_TEXTO_ANOTACAO);
}

/** Remove *negrito*, _itálico_ e as linhas divisórias do texto do WhatsApp. */
function limparRelatorioParaCrm(texto) {
  if (!texto) return '';
  return String(texto)
    .split(/\r?\n/)
    .map((l) => l.replace(/[*_]/g, '').replace(/^\s+/, (m) => m.replace(/\t/g, '  ')).trimEnd())
    .filter((l) => !/^[─—-]{3,}$/.test(l.trim()))
    .join('\n')
    .trim();
}

/** Cria a anotação vinculada ao card. */
async function criarAnotacao(dealId, texto) {
  if (!dealId || !texto) return { ok: false, erro: 'sem deal_id ou texto' };
  const r = await chamarRd('/api/v1/activities', {
    metodo: 'POST',
    corpo: { activity: { deal_id: dealId, text: texto } },
  });
  return { ok: r.ok, id: r.dados && (r.dados._id || r.dados.id), erro: r.erro };
}

/* =============================================================================
 *  6. HANDLER DA NETLIFY FUNCTION
 * ========================================================================== */

/** Resposta padronizada — sempre JSON, sempre com CORS. */
function responder(status, corpo) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(corpo) };
}

exports.handler = async function (event) {
  // ---- Pré-flight CORS -----------------------------------------------------
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ---- Método -------------------------------------------------------------
  if (event.httpMethod !== 'POST') {
    return responder(405, { success: false, error: 'Use POST.' });
  }

  // ---- Token configurado? -------------------------------------------------
  if (!RD_TOKEN) {
    console.error('[RD CRM] variável de ambiente RD_CRM_TOKEN não configurada.');
    // 200 de propósito: o front-end não deve travar o WhatsApp por isso.
    return responder(200, { success: false, error: 'RD_CRM_TOKEN não configurado no site.' });
  }

  // ---- Corpo da requisição ------------------------------------------------
  let entrada = {};
  try {
    const bruto = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}');
    entrada = JSON.parse(bruto || '{}');
  } catch (e) {
    console.error('[RD CRM] JSON inválido no corpo da requisição: %s', e && e.message);
    return responder(200, { success: false, error: 'JSON inválido.' });
  }

  try {
    /* --- 6.1 Parser: respostas estruturadas têm prioridade sobre o texto --- */
    const doTexto      = parsearRelatorio(entrada.message);
    const dasRespostas = achatarRespostas(entrada.respostas);
    const dados = Object.assign({}, doTexto, dasRespostas); // estruturado vence
    if (entrada.consultor && !dados.consultor) dados.consultor = limpo(entrada.consultor);

    /* Telefone do lead: vem do link que o consultor gerou (?c=), não do
       formulário. É a fonte mais confiável, porque é o mesmo número que ele
       já usou para chamar a pessoa no WhatsApp. */
    if (entrada.telefone && !dados.telefone) dados.telefone = limpo(entrada.telefone);

    /* Contexto do evento. A ordem de precedência é:
         corpo da requisição  ➔  variável de ambiente  ➔  padrão do arquivo.
       É o que permite usar este mesmo endpoint no próximo evento mandando
       {"origem_evento": "APAS Show"} — sem deploy, sem clonar arquivo. */
    const contexto = {
      evento:      limpo(entrada.origem_evento) || EVENTO_PADRAO,
      fonteOrigem: limpo(entrada.fonte_origem)  || FONTE_ORIGEM_EVENTO,
    };
    console.log('[RD CRM] captação de evento: "%s" | fonte/origem: "%s"',
      contexto.evento, contexto.fonteOrigem);

    // Razão social: prioriza o retorno da Receita feito no navegador.
    const receita = entrada.receita && typeof entrada.receita === 'object' ? entrada.receita : null;

    // Sem nada aproveitável, não cria card vazio.
    if (!limpo(dados.nome) && !limpo(dados.cnpj) && !limpo(dados.email)) {
      console.warn('[RD CRM] payload sem nome, e-mail ou CNPJ — nada a criar.');
      return responder(200, { success: false, error: 'Payload sem dados mínimos do lead.' });
    }

    /* --- 6.2 Empresa (organização), quando há razão social ---------------- */
    const empresa = await garantirOrganizacao(dados, receita, contexto);

    /* --- 6.3 Contato (idempotente, já vinculado à empresa) ---------------- */
    const contato = await garantirContato(dados, empresa.id);

    /* --- 6.4 Negociação --------------------------------------------------- */
    const negociacao = await criarNegociacao(dados, receita, contato.id, empresa.id, contexto);
    if (!negociacao.ok) {
      return responder(200, {
        success: false,
        evento: contexto.evento,
        contact_id: contato.id || null,
        organization_id: empresa.id || null,
        error: 'Falha ao criar a negociação: ' + (negociacao.erro || 'erro desconhecido'),
      });
    }

    const dealId = negociacao.deal._id || negociacao.deal.id || '';
    console.log('[RD CRM] negociação criada: %s "%s" (etapa %s | funil %s | via %s)',
      dealId, negociacao.deal.name || '', DEAL_STAGE_ID, DEAL_PIPELINE_ID, negociacao.tentativa);

    /* --- 6.5 Anotação com o diagnóstico integral -------------------------- */
    const anotacao = await criarAnotacao(dealId, montarTextoAnotacao(entrada, dados, receita, contexto));
    if (!anotacao.ok) console.warn('[RD CRM] anotação não criada: %s', anotacao.erro);

    /* --- 6.6 Retorno seguro ----------------------------------------------- */
    return responder(200, {
      success: true,
      deal_id: dealId,
      deal_name: negociacao.deal.name || null,
      evento: contexto.evento,
      fonte_origem: contexto.fonteOrigem,
      contact_id: contato.id || null,
      contact_created: contato.criado,
      organization_id: empresa.id || null,
      organization_created: empresa.criada,
      activity_id: anotacao.id || null,
      deal_stage_id: DEAL_STAGE_ID,
      link_vinculo: negociacao.tentativa,
      warnings: [
        anotacao.ok ? null : 'anotacao_nao_criada',
        contato.id ? null : 'contato_nao_identificado',
        (nomeDaEmpresa(dados, receita) && !empresa.id) ? 'empresa_nao_criada' : null,
        dados.telefone ? null : 'telefone_ausente_no_link',
      ].filter(Boolean),
    });
  } catch (e) {
    // Qualquer exceção inesperada: loga e devolve 200 para não travar o fluxo.
    console.error('[RD CRM] erro inesperado: %s\n%s', e && e.message, e && e.stack);
    return responder(200, { success: false, error: 'Erro inesperado: ' + String((e && e.message) || e) });
  }
};

/* Exporta os utilitários para teste unitário local (node scripts/testar-parser.js). */
exports._internos = {
  parsearRelatorio,
  achatarRespostas,
  normalizarQtdLojas,
  normalizarModeloRede,
  normalizarStatusCnpj,
  normalizarSistema,
  normalizarStatusOperacional,
  separarCidadeUf,
  formatarCnpj,
  formatarTelefoneBr,
  nomeDaEmpresa,
  cnpjValido,
  montarCamposPersonalizados,
  montarTitulo,
  montarTextoAnotacao,
  CF,
  OPCOES,
  EVENTO_PADRAO,
  FONTE_ORIGEM_EVENTO,
};