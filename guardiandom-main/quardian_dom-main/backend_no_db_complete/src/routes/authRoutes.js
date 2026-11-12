const express = require('express');
const router = express.Router();
const { db, get, run } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'segredo';
const TOKEN_MAX_AGE = 60 * 60 * 24 * 7; // 7 days in seconds
const COOKIE_SECURITY = process.env.NODE_ENV === 'production' ? '; Secure' : '';

function setTokenCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `token=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${TOKEN_MAX_AGE}; SameSite=Lax${COOKIE_SECURITY}`
  );
}

router.get('/', (req, res) => {
  res.send('Auth OK');
});

router.post('/register', async (req, res) => {
  // aceitar `name`, `cpf`, `birthdate` e opcional `telefone`
  const { name, cpf, birthdate, telefone, email, password } = req.body;
  if (!name || !cpf || !email || !password || !birthdate)
    return res.status(400).json({ error: 'name, cpf, birthdate, email and password required' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    // inserir birthdate na coluna correspondente
    const stmt = await run(
      `INSERT INTO users (name,email,password_hash,cpf,telefone,birthdate) VALUES (?,?,?,?,?,?)`,
      [name, email, hash, cpf || null, telefone || null, birthdate]
    );
    const payload = { id: stmt.lastID, email };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_MAX_AGE });
    // set HttpOnly cookie
    setTokenCookie(res, token);
    res.json({
      message: 'Usuário cadastrado',
      usuario: {
        id: stmt.lastID,
        name,
        telefone: telefone || null,
        email,
        cpf: cpf || null,
        birthdate,
      },
    });
  } catch (err) {
    if (err && ((err.message && err.message.includes('UNIQUE')) || err.code === 'ER_DUP_ENTRY'))
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  try {
    const row = await get(
      `SELECT id,name,email,cpf,telefone,password_hash FROM users WHERE email = ?`,
      [email]
    );
    if (!row) return res.status(401).json({ error: 'Credenciais inválidas' });
    const ok = bcrypt.compareSync(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

    const { password_hash, ...user } = row;
    const payload = { id: user.id, email: user.email };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_MAX_AGE });
    setTokenCookie(res, token);
    res.json({ message: 'Login realizado', usuario: user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao autenticar' });
  }
});

router.post('/logout', (req, res) => {
  // Clear the token cookie
  res.setHeader(
    'Set-Cookie',
    `token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${COOKIE_SECURITY}`
  );
  res.json({ message: 'Logout realizado' });
});

module.exports = router;
