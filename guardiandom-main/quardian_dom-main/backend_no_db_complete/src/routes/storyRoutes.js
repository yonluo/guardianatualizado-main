const express = require('express');
const path = require('node:path');
const { all, get, ready, run } = require('../db');
const { authenticate } = require('../services/auth');
const { encryptSecret, decryptSecret } = require('../services/cameraSecurity');
const { validateCameraReportEvidence } = require('../services/cameraReportEvidence');
const { createNotification } = require('../services/notifications');

const router = express.Router();
const STORY_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_STORY_MEDIA_BYTES = 4 * 1024 * 1024;
const MAX_STORY_TOTAL_BYTES = 10 * 1024 * 1024;
const allowedMedia = new Map([
  ['image/jpeg', { type: 'image', extensions: ['.jpg', '.jpeg'] }],
  ['image/png', { type: 'image', extensions: ['.png'] }],
  ['image/webp', { type: 'image', extensions: ['.webp'] }],
  ['video/mp4', { type: 'video', extensions: ['.mp4'] }],
  ['video/webm', { type: 'video', extensions: ['.webm'] }],
]);
const allowedCategories = new Set(['Aviso', 'Segurança', 'Comunidade', 'Suporte', 'Trânsito', 'Outros']);

router.use(authenticate);
router.use(async (_req, res, next) => {
  try {
    await ready;
    return next();
  } catch {
    return res.status(503).json({ error: 'O banco de Stories não está disponível.' });
  }
});

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function matchesMediaSignature(mimeType, data) {
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (mimeType === 'video/mp4') return data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp';
  if (mimeType === 'video/webm') return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function validateStoryMedia(file) {
  if (!file) return null;
  const mediaType = allowedMedia.get(file.mimeType);
  if (!mediaType || typeof file.fileName !== 'string' || typeof file.data !== 'string') {
    const error = new Error('Use uma foto ou vídeo JPG, PNG, WebP, MP4 ou WebM.');
    error.status = 400;
    throw error;
  }
  const fileName = path.basename(file.fileName.replace(/\\/g, '/')).replace(/[\r\n"]/g, '').slice(0, 255);
  if (!mediaType.extensions.includes(path.extname(fileName).toLowerCase())) {
    const error = new Error('A extensão não corresponde ao formato da mídia.');
    error.status = 400;
    throw error;
  }
  if (file.data.length > Math.ceil((MAX_STORY_MEDIA_BYTES * 4) / 3) + 8) {
    const error = new Error('A mídia do Story deve ter até 4 MB.');
    error.status = 413;
    throw error;
  }
  const data = Buffer.from(file.data, 'base64');
  if (!data.length || data.length > MAX_STORY_MEDIA_BYTES || data.toString('base64') !== file.data || !matchesMediaSignature(file.mimeType, data)) {
    const error = new Error('A mídia está inválida ou não corresponde ao formato informado.');
    error.status = 400;
    throw error;
  }
  return { type: mediaType.type, mimeType: file.mimeType, fileName, data };
}

function storyDto(story, viewerId) {
  const isAlert = Boolean(story.isAlert);
  const hasEvidence = Boolean(story.encryptedReportEvidence);
  return {
    id: story.id,
    userId: story.userId,
    author: story.author,
    category: story.category,
    content: story.content,
    isAlert,
    hasMedia: Boolean(story.mediaType),
    mediaType: story.mediaType,
    mediaUrl: story.mediaType ? `/api/stories/${encodeURIComponent(story.id)}/media` : null,
    hasReportEvidence: hasEvidence,
    reportDate: story.reportDate || null,
    reportStatus: isAlert && hasEvidence ? 'BO anexado · não verificado' : null,
    evidenceUrl: hasEvidence && Number(story.userId) === Number(viewerId)
      ? `/api/stories/${encodeURIComponent(story.id)}/evidence`
      : null,
    createdAt: story.createdAt,
    expiresAt: Number(story.expiresAt),
  };
}

async function purgeExpiredStories() {
  try {
    await ready;
    await run('DELETE FROM community_stories WHERE expires_at <= ?', [Date.now()]);
  } catch (error) {
    console.error('expired story cleanup failed', error.message);
  }
}

const cleanupTimer = setInterval(purgeExpiredStories, 60 * 60 * 1000);
cleanupTimer.unref();
purgeExpiredStories();

router.get('/', async (req, res) => {
  try {
    await purgeExpiredStories();
    const stories = await all(
      `SELECT s.id, s.user_id AS userId, u.name AS author, s.category, s.content,
        s.media_type AS mediaType, s.is_alert AS isAlert, s.report_date AS reportDate,
        s.encrypted_report_evidence AS encryptedReportEvidence,
        s.created_at AS createdAt, s.expires_at AS expiresAt
       FROM community_stories s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ? ORDER BY s.created_at DESC, s.id DESC LIMIT 100`,
      [Date.now()]
    );
    return res.json(stories.map((story) => storyDto(story, req.user.id)));
  } catch (error) {
    console.error('story list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar os Stories.' });
  }
});

router.post('/', async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const category = typeof req.body?.category === 'string' ? req.body.category.trim() : 'Comunidade';
  const isAlert = req.body?.isAlert === true;
  if (!allowedCategories.has(category)) return res.status(400).json({ error: 'Selecione uma categoria válida.' });
  if (content.length > 500) return res.status(400).json({ error: 'O texto do Story deve ter até 500 caracteres.' });

  let media;
  let reportEvidence;
  try {
    media = validateStoryMedia(req.body?.media);
    if (isAlert) {
      const reportNumber = typeof req.body?.reportNumber === 'string' ? req.body.reportNumber.trim() : '';
      if (!reportNumber || reportNumber.length > 40 || !validDate(req.body?.reportDate)) {
        return res.status(400).json({ error: 'Alertas exigem número e data do BO.' });
      }
      if (new Date(`${req.body.reportDate}T00:00:00`) > new Date(new Date().toDateString())) {
        return res.status(400).json({ error: 'A data do BO não pode estar no futuro.' });
      }
      reportEvidence = validateCameraReportEvidence(req.body?.reportEvidence);
      if (media && media.data.length + reportEvidence.data.length > MAX_STORY_TOTAL_BYTES) {
        return res.status(413).json({ error: 'A soma da mídia do Story e do BO deve ter até 10 MB.' });
      }
      if (!content) return res.status(400).json({ error: 'Descreva o ocorrido no Story de alerta.' });
    } else if (req.body?.reportEvidence || req.body?.reportNumber || req.body?.reportDate) {
      return res.status(400).json({ error: 'Ative “Alerta com BO” para anexar um boletim.' });
    }
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }

  if (!content && !media) return res.status(400).json({ error: 'Escreva um relato ou adicione uma foto/vídeo.' });

  const expiresAt = Date.now() + STORY_DURATION_MS;
  const reportNumber = isAlert ? encryptSecret(req.body.reportNumber.trim()) : null;
  const encryptedEvidence = reportEvidence
    ? encryptSecret(reportEvidence.data.toString('base64'))
    : null;
  try {
    const result = await run(
      `INSERT INTO community_stories
        (user_id, category, content, media_type, mime_type, file_name, media_data, is_alert,
         encrypted_report_number, report_date, report_mime_type, report_file_name,
         encrypted_report_evidence, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        category,
        content,
        media?.type || null,
        media?.mimeType || null,
        media?.fileName || null,
        media?.data || null,
        Number(isAlert),
        reportNumber,
        isAlert ? req.body.reportDate : null,
        reportEvidence?.mimeType || null,
        reportEvidence?.fileName || null,
        encryptedEvidence,
        expiresAt,
      ]
    );
    const story = await get(
      `SELECT s.id, s.user_id AS userId, u.name AS author, s.category, s.content,
        s.media_type AS mediaType, s.is_alert AS isAlert, s.report_date AS reportDate,
        s.encrypted_report_evidence AS encryptedReportEvidence,
        s.created_at AS createdAt, s.expires_at AS expiresAt
       FROM community_stories s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      [result.lastID]
    );
    if (isAlert) {
      const contacts = await all(
        `SELECT CASE WHEN requester_id = ? THEN recipient_id ELSE requester_id END AS userId
         FROM contacts WHERE status = 'accepted' AND (requester_id = ? OR recipient_id = ?)`,
        [req.user.id, req.user.id, req.user.id]
      );
      for (const contact of contacts) {
        await createNotification(
          req.app,
          contact.userId,
          'Alerta da comunidade',
          `${story.author} publicou um alerta: ${content.slice(0, 140)}`
        );
      }
    }
    return res.status(201).json(storyDto(story, req.user.id));
  } catch (error) {
    console.error('story create failed', error.message);
    return res.status(500).json({ error: 'Não foi possível publicar o Story.' });
  }
});

router.get('/:storyId/media', async (req, res) => {
  try {
    const story = await get(
      `SELECT mime_type AS mimeType, file_name AS fileName, media_data AS data
       FROM community_stories WHERE id = ? AND expires_at > ?`,
      [req.params.storyId, Date.now()]
    );
    if (!story?.data) return res.status(404).json({ error: 'Mídia do Story não encontrada.' });
    res.set({
      'Content-Type': story.mimeType,
      'Content-Length': story.data.length,
      'Content-Disposition': `inline; filename="${story.fileName.replace(/[\r\n"]/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(story.data);
  } catch (error) {
    console.error('story media lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar a mídia do Story.' });
  }
});

router.get('/:storyId/evidence', async (req, res) => {
  try {
    const story = await get(
      `SELECT user_id AS userId, report_mime_type AS mimeType, report_file_name AS fileName,
        encrypted_report_evidence AS encryptedEvidence
       FROM community_stories WHERE id = ? AND expires_at > ?`,
      [req.params.storyId, Date.now()]
    );
    if (!story || Number(story.userId) !== Number(req.user.id)) {
      return res.status(404).json({ error: 'Documento do BO não encontrado.' });
    }
    const data = Buffer.from(decryptSecret(story.encryptedEvidence), 'base64');
    res.set({
      'Content-Type': story.mimeType,
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${story.fileName.replace(/[\r\n"]/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(data);
  } catch (error) {
    console.error('story evidence lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar o documento do BO.' });
  }
});

router.delete('/:storyId', async (req, res) => {
  try {
    const result = await run('DELETE FROM community_stories WHERE id = ? AND user_id = ?', [req.params.storyId, req.user.id]);
    if (!result.affectedRows && !result.changes) return res.status(404).json({ error: 'Story não encontrado.' });
    return res.status(204).end();
  } catch (error) {
    console.error('story delete failed', error.message);
    return res.status(500).json({ error: 'Não foi possível excluir o Story.' });
  }
});

module.exports = router;
