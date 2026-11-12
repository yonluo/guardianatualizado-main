const mysql = require('mysql2/promise');
require('dotenv').config();

async function run() {
  const host = process.env.DB_HOST || 'localhost';
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASS || '';
  const database = process.env.DB_NAME || 'angel_guardian';

  const conn = await mysql.createConnection({ host, user, password, database });
  try {
    // check if column exists
    const [rows] = await conn.execute(`SHOW COLUMNS FROM users LIKE 'birthdate'`);
    if (rows.length === 0) {
      console.log('Adicionando coluna birthdate em users...');
      await conn.execute(`ALTER TABLE users ADD COLUMN birthdate DATE NULL`);
      console.log('Coluna birthdate adicionada.');
    } else {
      console.log('Coluna birthdate já existe. Nada a fazer.');
    }
  } catch (err) {
    console.error('Erro ao verificar/adicionar coluna birthdate:', err.message || err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

run();
