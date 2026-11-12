const express = require('express');
const router = express.Router();
const { authenticate } = require('../services/auth');
const { all, run } = require('../db');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const notifications = await all(
      `SELECT id, title AS titulo, message AS mensagem, is_read AS lida, created_at AS createdAt
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      [req.user.id]
    );
    return res.json(
      notifications.map((item) => {
        const title = String(item.titulo || '').toLocaleLowerCase('pt-BR');
        const category = title.includes('mensagem')
          ? 'message'
          : title.includes('contato') || title.includes('convite')
            ? 'contact'
            : title.includes('solicitação') || title.includes('acesso')
              ? 'camera'
              : title.includes('alerta')
                ? 'alert'
                : 'system';
        return {
          ...item,
          lida: item.lida === true || Number(item.lida) === 1,
          categoria: category,
        };
      })
    );
  } catch (error) {
    console.error('notification list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as notificações.' });
  }
});

router.put('/:id/read', async (req, res) => {
  try {
    const result = await run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!result.affectedRows && !result.changes) return res.status(404).json({ error: 'Notificação não encontrada.' });
    return res.json({ mensagem: 'Notificação marcada como lida.', id: req.params.id });
  } catch (error) {
    console.error('notification update failed', error.message);
    return res.status(500).json({ error: 'Não foi possível atualizar a notificação.' });
  }
});

router.put('/read-all', async (req, res) => {
  try {
    await run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [
      req.user.id,
    ]);
    return res.json({ mensagem: 'Todas as notificações foram marcadas como lidas.' });
  } catch (error) {
    console.error('notification read-all failed', error.message);
    return res.status(500).json({ error: 'Não foi possível atualizar as notificações.' });
  }
});

module.exports = router;
