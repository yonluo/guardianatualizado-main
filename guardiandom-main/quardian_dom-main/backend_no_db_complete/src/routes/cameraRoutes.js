const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { all, get, ready, run } = require('../db');
const { validateCameraReportEvidence } = require('../services/cameraReportEvidence');
const { authenticate } = require('../services/auth');
const {
  assertAllowedRtspUrl,
  decryptSecret,
  encryptSecret,
} = require('../services/cameraSecurity');
const {
  addCameraPath,
  fetchHlsResource,
  getCameraPathStatus,
  getHlsBaseUrl,
  getRetentionDays,
  removeCameraPath,
} = require('../services/mediaMtx');

const router = express.Router();
function publicCamera(camera) {
  return {
    id: camera.id,
    name: camera.name,
    location: camera.location,
    latitude: camera.latitude,
    longitude: camera.longitude,
    isPublic: Boolean(camera.is_public),
    reportNumber: decryptSecret(camera.encrypted_report_number),
    reportDate: camera.report_date,
    releaseStatus: camera.release_status,
    createdAt: camera.created_at,
  };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(':').map(Number);
  return hours <= 23 && minutes <= 59;
}

function getReviewerIds() {
  return (process.env.CAMERA_REVIEWER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function requireReviewer(req, res, next) {
  const reviewers = getReviewerIds();
  if (!reviewers.length) {
    return res
      .status(503)
      .json({ error: 'A lista de administradores de câmeras ainda não foi configurada.' });
  }
  if (!reviewers.includes(String(req.user.id))) {
    return res
      .status(403)
      .json({ error: 'Somente administradores autorizados podem analisar o BO.' });
  }
  return next();
}

async function findOwnedCamera(cameraId, ownerId) {
  return get(
    `SELECT id, owner_id, name, location, latitude, longitude, encrypted_report_number, report_date,
      encrypted_source, path_name, release_status, is_public, created_at
     FROM managed_cameras WHERE id = ? AND owner_id = ?`,
    [cameraId, ownerId]
  );
}

async function findAccessibleCamera(cameraId, userId) {
  return get(
    `SELECT c.id, c.owner_id, c.name, c.location, c.latitude, c.longitude,
      c.encrypted_report_number, c.report_date, c.encrypted_source, c.path_name,
      c.release_status, c.is_public, c.created_at
     FROM managed_cameras c
     WHERE c.id = ? AND (c.owner_id = ? OR EXISTS (
       SELECT 1 FROM camera_access_requests r
       WHERE r.camera_id = c.id AND r.requester_id = ? AND r.status = 'approved'
     ))`,
    [cameraId, userId, userId]
  );
}

function validateHlsResource(resource) {
  if (
    !resource ||
    resource
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/.test(part))
  ) {
    return false;
  }
  return true;
}

function rewriteManifest(manifest, upstreamUrl, cameraId, pathName) {
  const mediaBase = getHlsBaseUrl();
  const cameraPrefix = `${mediaBase.pathname.replace(/\/+$/, '')}/${encodeURIComponent(pathName)}/`;
  const localPrefix = `/api/cameras/${encodeURIComponent(cameraId)}/live/`;
  const rewriteUri = (uri) => {
    const resolved = new URL(uri, upstreamUrl);
    if (resolved.origin !== upstreamUrl.origin || !resolved.pathname.startsWith(cameraPrefix)) {
      throw new Error('O manifesto HLS contém um endereço fora do caminho autorizado.');
    }
    const relative = resolved.pathname.slice(cameraPrefix.length);
    if (!validateHlsResource(relative)) throw new Error('Recurso HLS inválido.');
    return `${localPrefix}${relative
      .split('/')
      .map(encodeURIComponent)
      .join('/')}${resolved.search}`;
  };

  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUri(uri)}"`);
      }
      return rewriteUri(line);
    })
    .join('\n');
}

function recordingsRoot() {
  const configured = process.env.RECORDINGS_DIRECTORY;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error('RECORDINGS_DIRECTORY must be an absolute path shared with MediaMTX.');
  }
  return path.resolve(configured);
}

function recordingTimestamp(fileName) {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-\d+\.mp4$/);
  if (!match) return null;
  return { date: match[1], time: match[2].replace(/-/g, ':') };
}

async function ensureCameraPath(camera) {
  let status = await getCameraPathStatus(camera.path_name);
  if (status) return status;

  try {
    await addCameraPath(camera.path_name, decryptSecret(camera.encrypted_source));
  } catch (error) {
    status = await getCameraPathStatus(camera.path_name);
    if (status) return status;
    throw error;
  }
  return getCameraPathStatus(camera.path_name);
}

let reconcilingCameraPaths = false;
async function reconcileApprovedCameraPaths() {
  if (reconcilingCameraPaths) return;
  reconcilingCameraPaths = true;
  try {
    await ready;
    const cameras = await all(
      `SELECT id, path_name, encrypted_source FROM managed_cameras
       WHERE release_status = 'approved'`
    );
    for (const camera of cameras) {
      try {
        await ensureCameraPath(camera);
      } catch (error) {
        console.error('approved camera path reconciliation failed', camera.id, error.message);
      }
    }
  } catch (error) {
    console.error('approved camera path reconciliation failed', error.message);
  } finally {
    reconcilingCameraPaths = false;
  }
}

ready.then(reconcileApprovedCameraPaths).catch((error) => {
  console.error('approved camera path reconciliation failed', error.message);
});
const cameraPathReconciliationTimer = setInterval(reconcileApprovedCameraPaths, 60_000);
cameraPathReconciliationTimer.unref();

router.use(authenticate);
router.use(async (_req, res, next) => {
  try {
    await ready;
    return next();
  } catch {
    return res.status(503).json({ error: 'O banco de dados das câmeras não está disponível.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const cameras = await all(
      `SELECT id, owner_id, name, location, latitude, longitude, encrypted_report_number, report_date,
        path_name, release_status, is_public, created_at
       FROM managed_cameras WHERE owner_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(cameras.map(publicCamera));
  } catch (error) {
    console.error('camera list failed', error);
    res.status(500).json({ error: 'Não foi possível carregar suas câmeras.' });
  }
});

router.get('/public', async (_req, res) => {
  try {
    const cameras = await all(
      `SELECT id, name, location, latitude, longitude, is_public, release_status
       FROM managed_cameras WHERE release_status = 'approved' AND is_public = 1
       AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY created_at DESC`
    );
    return res.json(cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      location: camera.location,
      latitude: camera.latitude,
      longitude: camera.longitude,
      isPublic: true,
      releaseStatus: camera.release_status,
      serverManaged: true,
    })));
  } catch (error) {
    console.error('public camera list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as câmeras públicas.' });
  }
});

router.get('/shared', async (req, res) => {
  try {
    const cameras = await all(
      `SELECT c.id, c.owner_id, c.name, c.location, c.latitude, c.longitude,
        c.encrypted_report_number, c.report_date, c.is_public, c.release_status, c.created_at
       FROM managed_cameras c JOIN camera_access_requests r ON r.camera_id = c.id
       WHERE r.requester_id = ? AND r.status = 'approved' AND c.release_status = 'approved'
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return res.json(cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      location: camera.location,
      latitude: camera.latitude,
      longitude: camera.longitude,
      isPublic: Boolean(camera.is_public),
      releaseStatus: camera.release_status,
      serverManaged: true,
      sharedAccess: true,
    })));
  } catch (error) {
    console.error('shared camera list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as câmeras compartilhadas.' });
  }
});

router.patch('/:cameraId/visibility', async (req, res) => {
  const isPublic = req.body?.isPublic;
  if (typeof isPublic !== 'boolean') return res.status(400).json({ error: 'Informe a visibilidade desejada.' });
  try {
    const camera = await findOwnedCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    if (camera.release_status !== 'approved') return res.status(409).json({ error: 'A câmera precisa estar liberada antes da publicação.' });
    if (isPublic && (camera.latitude === null || camera.longitude === null)) {
      return res.status(400).json({ error: 'Informe latitude e longitude antes de publicar no mapa.' });
    }
    await run('UPDATE managed_cameras SET is_public = ? WHERE id = ? AND owner_id = ?', [Number(isPublic), camera.id, req.user.id]);
    return res.json({ id: camera.id, isPublic });
  } catch (error) {
    console.error('camera visibility update failed', error.message);
    return res.status(500).json({ error: 'Não foi possível atualizar a visibilidade.' });
  }
});

router.post('/', async (req, res) => {
  const {
    name,
    location,
    latitude,
    longitude,
    reportNumber,
    reportDate,
    reportEvidence: reportFile,
    rtspUrl,
    streamUrl,
    cameraSourceUrl,
    cameraProtocol,
  } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanLocation = typeof location === 'string' ? location.trim() : '';
  const cleanReportNumber = typeof reportNumber === 'string' ? reportNumber.trim() : '';
  const cleanLatitude =
    latitude === '' || latitude === null || latitude === undefined ? null : Number(latitude);
  const cleanLongitude =
    longitude === '' || longitude === null || longitude === undefined ? null : Number(longitude);

  if (!cleanName || cleanName.length > 80 || !cleanLocation || cleanLocation.length > 180) {
    return res.status(400).json({ error: 'Informe um nome e local válidos para a câmera.' });
  }
  if (!cleanReportNumber || cleanReportNumber.length > 40 || !validDate(reportDate)) {
    return res.status(400).json({ error: 'O número e a data do BO são obrigatórios.' });
  }
  if (new Date(`${reportDate}T00:00:00`) > new Date(new Date().toDateString())) {
    return res.status(400).json({ error: 'A data do BO não pode estar no futuro.' });
  }
  let reportEvidence;
  try {
    reportEvidence = validateCameraReportEvidence(reportFile);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (
    (cleanLatitude === null) !== (cleanLongitude === null) ||
    (cleanLatitude !== null &&
      (!Number.isFinite(cleanLatitude) ||
        !Number.isFinite(cleanLongitude) ||
        cleanLatitude < -90 ||
        cleanLatitude > 90 ||
        cleanLongitude < -180 ||
        cleanLongitude > 180))
  ) {
    return res
      .status(400)
      .json({ error: 'Informe coordenadas válidas ou deixe latitude e longitude vazias.' });
  }
  const streamInput =
    typeof cameraSourceUrl === 'string'
      ? cameraSourceUrl
      : typeof streamUrl === 'string'
        ? streamUrl
        : typeof rtspUrl === 'string'
          ? rtspUrl
          : '';
  const normalizedStreamInput = streamInput.trim();

  if (typeof normalizedStreamInput !== 'string' || normalizedStreamInput.length === 0 || normalizedStreamInput.length > 2048) {
    return res.status(400).json({
      error: 'Informe o endereço do stream da câmera (RTSP, RTSPS, HTTP ou MJPEG) do fabricante.',
    });
  }

  let source;
  let encryptedSource;
  try {
    source = assertAllowedRtspUrl(normalizedStreamInput);
    encryptedSource = encryptSecret(source);
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({
      error:
        status === 503
          ? 'O armazenamento criptografado de credenciais ainda não foi configurado no servidor.'
          : error.message,
    });
  }

  const id = crypto.randomUUID();
  const pathName = `guardian-${id.replace(/-/g, '')}`;
  let cameraCreated = false;
  try {
    await run(
      `INSERT INTO managed_cameras
        (id, owner_id, name, location, latitude, longitude, encrypted_report_number, report_date,
         encrypted_source, path_name, release_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reviewing')`,
      [
        id,
        req.user.id,
        cleanName,
        cleanLocation,
        cleanLatitude,
        cleanLongitude,
        encryptSecret(cleanReportNumber),
        reportDate,
        encryptedSource,
        pathName,
      ]
    );
    cameraCreated = true;
    await run(
      `INSERT INTO camera_report_evidence (camera_id, mime_type, file_name, encrypted_data)
       VALUES (?, ?, ?, ?)`,
      [
        id,
        reportEvidence.mimeType,
        reportEvidence.fileName,
        encryptSecret(reportEvidence.data.toString('base64')),
      ]
    );
    await addCameraPath(pathName, source);
    const approval = await run(
      `UPDATE managed_cameras SET release_status = 'approved'
       WHERE id = ? AND owner_id = ? AND release_status = 'reviewing'`,
      [id, req.user.id]
    );
    if (approval.affectedRows === 0 || approval.changes === 0) {
      throw new Error('Camera approval state changed unexpectedly.');
    }
    const camera = await findOwnedCamera(id, req.user.id);
    res.status(201).json(publicCamera(camera));
  } catch (error) {
    console.error('camera registration failed', error.message);
    try {
      await removeCameraPath(pathName);
    } catch (cleanupError) {
      console.error('camera registration path cleanup failed', cleanupError.message);
    }
    if (cameraCreated) {
      try {
        await run('DELETE FROM camera_report_evidence WHERE camera_id = ?', [id]);
        await run('DELETE FROM managed_cameras WHERE id = ?', [id]);
      } catch (cleanupError) {
        console.error('camera registration data cleanup failed', cleanupError.message);
      }
    }
    res.status(error.status === 503 ? 503 : 502).json({
      error:
        error.status === 503
          ? 'A configuração segura das câmeras ainda não está completa no servidor.'
          : 'Não foi possível provisionar a câmera. Verifique a conexão privada com o MediaMTX e tente novamente.',
    });
  } finally {
    source = null;
    encryptedSource = null;
  }
});

router.get('/:cameraId/report-evidence', async (req, res) => {
  try {
    const camera = await findOwnedCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    const evidence = await get(
      `SELECT mime_type AS mimeType, file_name AS fileName, encrypted_data AS encryptedData
       FROM camera_report_evidence WHERE camera_id = ?`,
      [camera.id]
    );
    if (!evidence) return res.status(404).json({ error: 'Arquivo do BO não encontrado.' });
    const data = Buffer.from(decryptSecret(evidence.encryptedData), 'base64');
    res.set({
      'Content-Type': evidence.mimeType,
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${evidence.fileName.replace(/[\r\n"]/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(data);
  } catch (error) {
    console.error('camera report evidence lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar o arquivo do BO.' });
  }
});

router.get('/review/pending', requireReviewer, async (_req, res) => {
  try {
    const cameras = await all(
      `SELECT id, name, location, encrypted_report_number, report_date, created_at
       FROM managed_cameras WHERE release_status = 'pending' ORDER BY created_at ASC`
    );
    res.json(
      cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        location: camera.location,
        reportNumber: decryptSecret(camera.encrypted_report_number),
        reportDate: camera.report_date,
        createdAt: camera.created_at,
      }))
    );
  } catch (error) {
    console.error('pending camera review list failed', error);
    res.status(500).json({ error: 'Não foi possível carregar as solicitações pendentes.' });
  }
});

router.post('/:cameraId/review', requireReviewer, async (req, res) => {
  const decision = req.body?.decision;
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'A decisão deve ser approve ou reject.' });
  }
  try {
    const camera = await get(
      `SELECT id, encrypted_source, path_name, release_status
       FROM managed_cameras WHERE id = ?`,
      [req.params.cameraId]
    );
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    if (camera.release_status !== 'pending') {
      return res.status(409).json({ error: 'Esta solicitação já foi analisada.' });
    }

    if (decision === 'reject') {
      const update = await run(
        `UPDATE managed_cameras
         SET release_status = 'rejected', review_by = ?, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND release_status = 'pending'`,
        [req.user.id, camera.id]
      );
      if (update.affectedRows === 0 || update.changes === 0) {
        return res.status(409).json({ error: 'Esta solicitação já foi analisada.' });
      }
      return res.json({ id: camera.id, releaseStatus: 'rejected' });
    }

    const claim = await run(
      `UPDATE managed_cameras SET release_status = 'reviewing'
       WHERE id = ? AND release_status = 'pending'`,
      [camera.id]
    );
    if (claim.affectedRows === 0 || claim.changes === 0) {
      return res.status(409).json({ error: 'Esta solicitação já foi analisada.' });
    }
    try {
      await addCameraPath(camera.path_name, decryptSecret(camera.encrypted_source));
      const approval = await run(
        `UPDATE managed_cameras
         SET release_status = 'approved', review_by = ?, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = ? AND release_status = 'reviewing'`,
        [req.user.id, camera.id]
      );
      if (approval.affectedRows === 0 || approval.changes === 0) {
        throw new Error('Camera approval state changed unexpectedly.');
      }
    } catch (error) {
      try {
        await removeCameraPath(camera.path_name);
      } catch (cleanupError) {
        console.error('camera path cleanup failed', cleanupError.message);
      }
      try {
        await run(
          `UPDATE managed_cameras SET release_status = 'pending'
           WHERE id = ? AND release_status = 'reviewing'`,
          [camera.id]
        );
      } catch (restoreError) {
        console.error('camera review state restore failed', restoreError.message);
      }
      throw error;
    }
    res.json({ id: camera.id, releaseStatus: decision === 'approve' ? 'approved' : 'rejected' });
  } catch (error) {
    console.error('camera review failed', error.message);
    res.status(error.status === 503 ? 503 : 502).json({
      error: 'Não foi possível concluir a análise ou provisionar a câmera no MediaMTX.',
    });
  }
});

router.get('/:cameraId/status', async (req, res) => {
  try {
    const camera = await findAccessibleCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    if (camera.release_status !== 'approved') {
      return res
        .status(403)
        .json({ error: 'A câmera só pode ser acessada após a aprovação do BO.' });
    }
    const status = await ensureCameraPath(camera);
    res.json({
      status: status?.ready ? 'online' : 'offline',
      retentionDays: getRetentionDays(),
    });
  } catch (error) {
    console.error('camera status check failed', error.message);
    res.status(503).json({ error: 'Não foi possível consultar a conexão da câmera.' });
  }
});

router.get('/:cameraId/live/*', async (req, res) => {
  const resource = req.params[0] || '';
  if (!validateHlsResource(resource)) {
    return res.status(400).json({ error: 'Recurso HLS inválido.' });
  }
  try {
    const camera = await findAccessibleCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    if (camera.release_status !== 'approved') {
      return res
        .status(403)
        .json({ error: 'A câmera só pode ser acessada após a aprovação do BO.' });
    }
    const { response, target } = await fetchHlsResource(camera.path_name, resource, req.headers);
    if (!response.ok)
      return res.status(response.status).json({ error: 'Transmissão indisponível.' });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': contentType,
    });
    if (response.headers.has('content-range'))
      res.set('Content-Range', response.headers.get('content-range'));
    if (response.headers.has('accept-ranges'))
      res.set('Accept-Ranges', response.headers.get('accept-ranges'));
    if (resource.endsWith('.m3u8')) {
      const manifest = await response.text();
      res
        .type('application/vnd.apple.mpegurl')
        .send(rewriteManifest(manifest, target, req.params.cameraId, camera.path_name));
      return;
    }
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    console.error('camera HLS proxy failed', error.message);
    if (!res.headersSent)
      res.status(502).json({ error: 'Não foi possível carregar a transmissão.' });
  }
});

router.get('/:cameraId/recordings', async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  const timeFrom = req.query.timeFrom;
  const timeTo = req.query.timeTo;
  if ((from && !validDate(from)) || (to && !validDate(to))) {
    return res.status(400).json({ error: 'Use datas no formato AAAA-MM-DD.' });
  }
  if ((timeFrom && !validTime(timeFrom)) || (timeTo && !validTime(timeTo))) {
    return res.status(400).json({ error: 'Use horários no formato HH:MM.' });
  }
  try {
    const camera = await findAccessibleCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    const root = recordingsRoot();
    const directory = path.resolve(root, camera.path_name);
    if (!directory.startsWith(`${root}${path.sep}`)) {
      return res.status(400).json({ error: 'Caminho de gravação inválido.' });
    }
    let fileNames;
    try {
      fileNames = await fs.promises.readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return res.json([]);
      throw error;
    }
    const recordings = [];
    for (const fileName of fileNames) {
      if (!/^[\d-]{10}_[\d-]{8}-\d+\.mp4$/.test(fileName)) continue;
      const timestamp = recordingTimestamp(fileName);
      if (!timestamp || (from && timestamp.date < from) || (to && timestamp.date > to)) continue;
      const time = timestamp.time;
      const timeMinute = time.slice(0, 5);
      if ((timeFrom && timeMinute < timeFrom) || (timeTo && timeMinute > timeTo)) continue;
      const filePath = path.join(directory, fileName);
      const fileStats = await fs.promises.lstat(filePath);
      if (!fileStats.isFile()) continue;
      recordings.push({
        fileName,
        date: timestamp.date,
        time,
        sizeBytes: fileStats.size,
        downloadUrl: `/api/cameras/${encodeURIComponent(camera.id)}/recordings/${encodeURIComponent(fileName)}`,
      });
    }
    recordings.sort((left, right) =>
      `${right.date} ${right.time}`.localeCompare(`${left.date} ${left.time}`)
    );
    res.json(recordings);
  } catch (error) {
    console.error('camera recordings list failed', error.message);
    res
      .status(503)
      .json({ error: 'Não foi possível listar as gravações configuradas no servidor.' });
  }
});

router.get('/:cameraId/recordings/:fileName', async (req, res) => {
  if (!/^[\d-]{10}_[\d-]{8}-\d+\.mp4$/.test(req.params.fileName)) {
    return res.status(400).json({ error: 'Arquivo de gravação inválido.' });
  }
  try {
    const camera = await findAccessibleCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    const root = recordingsRoot();
    const directory = path.resolve(root, camera.path_name);
    const filePath = path.resolve(directory, req.params.fileName);
    if (!filePath.startsWith(`${directory}${path.sep}`)) {
      return res.status(400).json({ error: 'Caminho de gravação inválido.' });
    }
    const fileStats = await fs.promises.lstat(filePath);
    if (!fileStats.isFile()) return res.status(404).json({ error: 'Gravação não encontrada.' });

    const range = req.headers.range;
    let start = 0;
    let end = fileStats.size - 1;
    let status = 200;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return res.status(416).end();
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) start = Math.max(0, fileStats.size - Number(match[2]));
      if (start > end || end >= fileStats.size) return res.status(416).end();
      status = 206;
    }
    res.status(status).set({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Content-Disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${req.params.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${fileStats.size}`);
    await pipeline(fs.createReadStream(filePath, { start, end }), res);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Gravação não encontrada.' });
    console.error('camera recording download failed', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Não foi possível baixar a gravação.' });
  }
});

router.delete('/:cameraId', async (req, res) => {
  try {
    const camera = await findOwnedCamera(req.params.cameraId, req.user.id);
    if (!camera) return res.status(404).json({ error: 'Câmera não encontrada.' });
    if (camera.release_status === 'approved') await removeCameraPath(camera.path_name);
    await run('DELETE FROM camera_report_evidence WHERE camera_id = ?', [camera.id]);
    await run('DELETE FROM managed_cameras WHERE id = ? AND owner_id = ?', [
      camera.id,
      req.user.id,
    ]);
    res.status(204).end();
  } catch (error) {
    console.error('camera deletion failed', error.message);
    res.status(503).json({ error: 'Não foi possível remover a câmera com segurança.' });
  }
});

module.exports = router;
