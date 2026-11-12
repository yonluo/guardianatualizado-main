const express = require('express');
const router = express.Router();
const { authenticate } = require('../services/auth');
const { get, run } = require('../db');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const row = await get(
      `SELECT id, name, name AS nome, email, cpf, telefone, avatar_url AS avatarUrl,
        bio, created_at AS createdAt FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!row) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(row);
  } catch (err) {
    console.error('profile lookup failed', err.message || err);
    res.status(500).json({ error: 'Não foi possível carregar o perfil.' });
  }
});

router.put('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const bio = typeof req.body?.bio === 'string' ? req.body.bio.trim() : '';
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150 || bio.length > 255) {
    return res.status(400).json({ error: 'Informe nome, e-mail e biografia válidos.' });
  }
  try {
    await run('UPDATE users SET name = ?, email = ?, bio = ? WHERE id = ?', [name, email, bio, req.user.id]);
    const user = await get('SELECT id, name, email, bio FROM users WHERE id = ?', [req.user.id]);
    return res.json({ mensagem: 'Perfil atualizado.', ...user });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Este e-mail já está sendo usado.' });
    }
    console.error('profile update failed', error.message);
    return res.status(500).json({ error: 'Não foi possível atualizar o perfil.' });
  }
});

module.exports = router;
