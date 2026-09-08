const https = require('https');

const RD_CRM_STAGE_ID = '6a70e1f68b8c0f00261e6af9'; // Lead Orgânico (LO)

function crmRequest(path, method, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, 'https://crm.rdstation.com.br');
    url.searchParams.set('token', token);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };

    const req = https.request(options, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => {
        try {
          const parsed = resData ? JSON.parse(resData) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject({ statusCode: res.statusCode, body: parsed });
          }
        } catch (e) {
          resolve({ raw: resData });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const token = process.env.RD_CRM_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'RD_CRM_TOKEN não configurada' })
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const nome = payload.nome || payload.name || 'Contato Sem Nome';
    const email = payload.email || '';
    const telefone = payload.telefone || payload.phone || '';
    const empresaNome = payload.empresa || payload.company || payload.razao_social || 'Empresa Sem Nome';
    const cargo = payload.cargo || '';

    const dealName = `${empresaNome}`;

    let orgId = null;
    try {
      const orgRes = await crmRequest('/api/v1/organizations', 'POST', {
        organization: { name: empresaNome }
      }, token);
      orgId = orgRes._id || orgRes.id;
    } catch (e) {}

    const dealBody = {
      deal: {
        name: dealName,
        deal_stage_id: RD_CRM_STAGE_ID
      }
    };
    if (orgId) dealBody.deal.organization_id = orgId;

    const dealRes = await crmRequest('/api/v1/deals', 'POST', dealBody, token);
    const dealId = dealRes._id || dealRes.id;

    try {
      await crmRequest('/api/v1/contacts', 'POST', {
        contact: {
          name: nome,
          title: cargo,
          emails: email ? [{ email: email }] : [],
          phones: telefone ? [{ phone: telefone, type: 'cellphone' }] : [],
          deal_ids: dealId ? [dealId] : []
        }
      }, token);
    } catch (e) {}

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, deal_id: dealId })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Erro ao processar' })
    };
  }
};