(async () => {
  try {
    const { get } = require('../src/db');
    const row = await get('SELECT COUNT(*) AS c FROM users');
    if (row) {
      console.log('OK: usuarios_count =', row.c !== undefined ? row.c : JSON.stringify(row));
    } else {
      console.log('OK: consulta retornou nulo/sem linhas');
    }
    process.exit(0);
  } catch (err) {
    console.error('ERRO:', err.message || err);
    process.exit(1);
  }
})();
