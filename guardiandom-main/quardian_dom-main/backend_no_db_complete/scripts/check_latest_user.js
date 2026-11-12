const mysql = require('mysql2/promise');
(async () => {
  try {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'angel_guardian',
      waitForConnections: true,
      connectionLimit: 5,
    });
    const [rows] = await pool.query(
      'SELECT id, name, email, cpf, birthdate, created_at FROM users ORDER BY id DESC LIMIT 1'
    );
    if (rows && rows.length) console.log('LAST USER:', rows[0]);
    else console.log('No users found');
    await pool.end();
  } catch (err) {
    console.error('ERROR', err.message || err);
    process.exit(1);
  }
})();
