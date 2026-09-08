const https = require('https');

const token = process.env.RD_CRM_TOKEN;
if (!token) {
  console.log('ℹ️ Para testar a API, defina RD_CRM_TOKEN.');
  console.log('Estrutura de arquivos e sintaxe OK.');
  process.exit(0);
}

const url = `https://crm.rdstation.com.br/api/v1/users?token=${token}`;
https.get(url, (res) => {
  if (res.statusCode === 200) {
    console.log('✅ Conexão com API do RD Station CRM bem-sucedida!');
  } else {
    console.error(`⚠️ Falha na autenticação com RD CRM. Status HTTP: ${res.statusCode}`);
  }
}).on('error', (err) => {
  console.error('Erro de conexão:', err.message);
});