const express = require('express');
const { get, ready, run } = require('../db');
const { calculateReputation } = require('../services/reputation');
const { authenticate } = require('../services/auth');

const router = express.Router();

router.use(authenticate);
router.use(async (_req, res, next) => {
  try {
    await ready;
    return next();
  } catch {
    return res.status(503).json({ error: 'O banco de dados não está disponível.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const [postCount, cameraCount] = await Promise.all([
      get('SELECT COUNT(*) AS count FROM community_posts WHERE user_id = ?', [req.user.id]),
      get(
        `SELECT COUNT(*) AS count FROM managed_cameras
         WHERE owner_id = ? AND release_status IN ('approved', 'pending', 'reviewing')`,
        [req.user.id]
      ),
    ]);
    return res.json(
      calculateReputation({
        communityPosts: postCount?.count,
        cameras: cameraCount?.count,
      })
    );
  } catch (error) {
    console.error('reputation lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível calcular a reputação.' });
  }
});

router.get('/feedback', async (req, res) => {
  try {
    const feedback = await get(
      `SELECT comment, updated_at AS updatedAt
       FROM site_feedback WHERE user_id = ?`,
      [req.user.id]
    );
    return res.json(feedback || { comment: '', updatedAt: null });
  } catch (error) {
    console.error('site feedback lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar seu comentário.' });
  }
});

router.post('/feedback', async (req, res) => {
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
  if (!comment || comment.length > 500) {
    return res.status(400).json({ error: 'Escreva um comentário de até 500 caracteres.' });
  }
  try {
    const existing = await get('SELECT user_id FROM site_feedback WHERE user_id = ?', [
      req.user.id,
    ]);
    if (existing) {
      await run(
        `UPDATE site_feedback SET comment = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [comment, req.user.id]
      );
    } else {
      await run('INSERT INTO site_feedback (user_id, comment) VALUES (?, ?)', [
        req.user.id,
        comment,
      ]);
    }
    return res.json({ comment, message: 'Comentário registrado.' });
  } catch (error) {
    console.error('site feedback save failed', error.message);
    return res.status(500).json({ error: 'Não foi possível enviar seu comentário.' });
  }
});

module.exports = router;
