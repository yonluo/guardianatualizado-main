const express = require('express');
const router = express.Router();
const { authenticate } = require('../services/auth');
const { all, get, run } = require('../db');
const { createNotification } = require('../services/notifications');

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const requests = await all(
      `SELECT r.id, r.camera_id AS cameraId, r.requester_id AS requesterId,
        r.owner_id AS ownerId, r.status, r.created_at AS createdAt, r.decided_at AS decidedAt,
        c.name AS cameraName, requester.name AS requesterName, owner.name AS ownerName
       FROM camera_access_requests r
       JOIN managed_cameras c ON c.id = r.camera_id
       JOIN users requester ON requester.id = r.requester_id
       JOIN users owner ON owner.id = r.owner_id
       WHERE r.requester_id = ? OR r.owner_id = ?
       ORDER BY r.created_at DESC`,
      [req.user.id, req.user.id]
    );
    return res.json(requests);
  } catch (error) {
    console.error('camera requests list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as solicitações.' });
  }
});

router.post('/solicitar', async (req, res) => {
  const cameraId = String(req.body?.cameraId || '');
  try {
    const camera = await get(
      'SELECT id, owner_id, name, release_status FROM managed_cameras WHERE id = ?',
      [cameraId]
    );
    if (!camera || camera.release_status !== 'approved') return res.status(404).json({ error: 'Câmera pública não encontrada.' });
    if (Number(camera.owner_id) === Number(req.user.id)) return res.status(400).json({ error: 'Você já é proprietário desta câmera.' });
    const existing = await get('SELECT id, status FROM camera_access_requests WHERE camera_id = ? AND requester_id = ?', [cameraId, req.user.id]);
    if (existing?.status === 'pending') return res.status(409).json({ error: 'Sua solicitação já está aguardando resposta.' });
    if (existing?.status === 'approved') return res.status(409).json({ error: 'Sua solicitação já foi aprovada.' });
    if (existing) {
      await run('UPDATE camera_access_requests SET status = ?, owner_id = ?, created_at = CURRENT_TIMESTAMP, decided_at = NULL WHERE id = ?', ['pending', camera.owner_id, existing.id]);
    } else {
      await run('INSERT INTO camera_access_requests (camera_id, requester_id, owner_id) VALUES (?, ?, ?)', [cameraId, req.user.id, camera.owner_id]);
    }
    const requester = await get('SELECT name FROM users WHERE id = ?', [req.user.id]);
    await createNotification(req.app, camera.owner_id, 'Solicitação de acesso', `${requester?.name || 'Uma pessoa'} solicitou acesso à câmera ${camera.name}.`);
    return res.status(201).json({ mensagem: 'Solicitação enviada ao proprietário.', cameraId });
  } catch (error) {
    console.error('camera access request failed', error.message);
    return res.status(500).json({ error: 'Não foi possível enviar a solicitação.' });
  }
});

router.put('/aprovar/:id', async (req, res) => {
  try {
    const request = await get('SELECT id, requester_id AS requesterId, owner_id AS ownerId FROM camera_access_requests WHERE id = ?', [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (Number(request.ownerId) !== Number(req.user.id)) return res.status(403).json({ error: 'Somente o proprietário pode responder.' });
    const result = await run("UPDATE camera_access_requests SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status = 'pending'", [request.id, req.user.id]);
    if (!result.affectedRows && !result.changes) return res.status(409).json({ error: 'A solicitação já foi respondida.' });
    await createNotification(req.app, request.requesterId, 'Solicitação aprovada', 'O proprietário aprovou sua solicitação. A transmissão continua restrita ao proprietário nesta versão.');
    return res.json({ mensagem: 'Solicitação aprovada.', solicitacao: request.id });
  } catch (error) {
    console.error('camera access approval failed', error.message);
    return res.status(500).json({ error: 'Não foi possível aprovar a solicitação.' });
  }
});

router.put('/recusar/:id', async (req, res) => {
  try {
    const request = await get('SELECT id, requester_id AS requesterId, owner_id AS ownerId FROM camera_access_requests WHERE id = ?', [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    if (Number(request.ownerId) !== Number(req.user.id)) return res.status(403).json({ error: 'Somente o proprietário pode responder.' });
    const result = await run("UPDATE camera_access_requests SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status = 'pending'", [request.id, req.user.id]);
    if (!result.affectedRows && !result.changes) return res.status(409).json({ error: 'A solicitação já foi respondida.' });
    await createNotification(req.app, request.requesterId, 'Solicitação recusada', 'O proprietário recusou sua solicitação de acesso.');
    return res.json({ mensagem: 'Solicitação recusada.', solicitacao: request.id });
  } catch (error) {
    console.error('camera access rejection failed', error.message);
    return res.status(500).json({ error: 'Não foi possível recusar a solicitação.' });
  }
});

router.put('/revogar/:id', async (req, res) => {
  try {
    const request = await get('SELECT id, requester_id AS requesterId FROM camera_access_requests WHERE id = ? AND owner_id = ? AND status = ?', [req.params.id, req.user.id, 'approved']);
    if (!request) return res.status(404).json({ error: 'Acesso aprovado não encontrado.' });
    await run("UPDATE camera_access_requests SET status = 'revoked', decided_at = CURRENT_TIMESTAMP WHERE id = ?", [request.id]);
    await createNotification(req.app, request.requesterId, 'Acesso revogado', 'O proprietário retirou o acesso à câmera.');
    return res.json({ mensagem: 'Acesso revogado.' });
  } catch (error) {
    console.error('camera access revoke failed', error.message);
    return res.status(500).json({ error: 'Não foi possível revogar o acesso.' });
  }
});

module.exports = router;
