(async () => {
  require('dotenv').config();
  // garantir que o script consulte o MySQL (mesma configuração do servidor)
  process.env.DB_TYPE = process.env.DB_TYPE || 'mysql';
  const http = require('http');
  const { get } = require('../src/db');

  const id = Date.now();
  const payload = {
    name: `Teste ${id}`,
    email: `teste-db-check+${id}@example.com`,
    password: 'Senha!123',
    cpf: '333.333.333-33',
    telefone: `(21) 9${String(id).slice(-8)}`,
  };

  const opts = {
    hostname: 'localhost',
    port: 4000,
    path: '/api/auth/register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
    },
  };

  function doPost() {
    return new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  try {
    console.log('POST /api/auth/register ->', payload.email);
    const r = await doPost();
    console.log('Resposta registro:', r.status, r.body && r.body.message ? r.body.message : r.body);

    // aguardar pequeno tempo para garantir inserção
    await new Promise((r) => setTimeout(r, 300));

    const row = await get('SELECT id,name,email,cpf,telefone FROM users WHERE email = ?', [
      payload.email,
    ]);
    if (row) {
      console.log('Registro no DB encontrado:', row);
      process.exit(0);
    } else {
      console.error('Registro não encontrado no DB');
      process.exit(2);
    }
  } catch (err) {
    console.error('Erro:', err.message || err);
    process.exit(1);
  }
})();
