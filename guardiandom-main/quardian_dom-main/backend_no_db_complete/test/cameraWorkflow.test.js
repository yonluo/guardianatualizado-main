const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const express = require('express');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { once } = require('node:events');

async function startServer(handler, t) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return `http://127.0.0.1:${server.address().port}/`;
}

test('requires a BO attachment, automatically releases private access, and isolates feedback', async (t) => {
  process.env.DB_TYPE = 'sqlite';
  process.env.DB_PATH = ':memory:';
  process.env.JWT_SECRET = 'camera-workflow-test-secret-0123456789';
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.CAMERA_ALLOWED_NETWORKS = '192.168.10.0/24';
  process.env.MEDIAMTX_API_USER = 'test-api';
  process.env.MEDIAMTX_API_PASSWORD = 'test-password';
  process.env.MEDIAMTX_RECORDINGS_PATH = '/data/guardian-recordings';
  const recordingsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'guardian-camera-recordings-'));
  process.env.RECORDINGS_DIRECTORY = recordingsRoot;
  t.after(() => fs.rm(recordingsRoot, { recursive: true, force: true }));

  const mediaRequests = [];
  process.env.MEDIAMTX_API_URL = await startServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    if (req.method === 'POST') {
      mediaRequests.push({
        method: req.method,
        url: req.url,
        body: body.length ? JSON.parse(Buffer.concat(body).toString()) : null,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }, t);

  const { get, ready, run } = require('../src/db');
  await ready;
  const owner = await run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`, [
    'Camera Owner',
    'camera-owner@example.test',
    'unused',
  ]);
  const other = await run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`, [
    'Other User',
    'other-user@example.test',
    'unused',
  ]);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/cameras', require('../src/routes/cameraRoutes'));
  app.use('/api/reputation', require('../src/routes/reputationRoutes'));
  const appUrl = await startServer(app, t);
  const ownerToken = jwt.sign({ id: owner.lastID }, process.env.JWT_SECRET);
  const otherToken = jwt.sign({ id: other.lastID }, process.env.JWT_SECRET);

  const incompleteResponse = await fetch(`${appUrl}api/cameras`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  assert.equal(incompleteResponse.status, 400);

  const pdf = Buffer.from('%PDF-1.7\n');
  const createResponse = await fetch(`${appUrl}api/cameras`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Entrada',
      location: 'Local privado',
      reportNumber: 'BO-2026-123',
      reportDate: new Date().toISOString().slice(0, 10),
      reportEvidence: {
        fileName: 'bo.pdf',
        mimeType: 'application/pdf',
        data: pdf.toString('base64'),
      },
      rtspUrl: 'rtsp://camuser:campass@192.168.10.25:554/live',
    }),
  });
  assert.equal(createResponse.status, 201);
  const camera = await createResponse.json();
  assert.equal(camera.releaseStatus, 'approved');
  assert.equal(JSON.stringify(camera).includes('camuser'), false);
  assert.equal(JSON.stringify(camera).includes('campass'), false);
  assert.equal(mediaRequests.length, 1);
  assert.equal(mediaRequests[0].method, 'POST');
  assert.match(mediaRequests[0].url, /^\/v3\/config\/paths\/add\/guardian-/);

  const cameraRecord = await get(
    'SELECT path_name, encrypted_source FROM managed_cameras WHERE id = ?',
    [camera.id]
  );
  assert.equal(cameraRecord.encrypted_source.startsWith('v1:'), true);
  assert.equal(cameraRecord.encrypted_source.includes('campass'), false);
  assert.equal(mediaRequests[0].body.source, 'rtsp://camuser:campass@192.168.10.25:554/live');
  const cameraListResponse = await fetch(`${appUrl}api/cameras`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const cameraList = await cameraListResponse.json();
  assert.equal(cameraListResponse.status, 200);
  assert.equal(JSON.stringify(cameraList).includes('camuser'), false);
  assert.equal(JSON.stringify(cameraList).includes('campass'), false);
  const cameraDirectory = path.join(recordingsRoot, cameraRecord.path_name);
  await fs.mkdir(cameraDirectory, { recursive: true });
  const recordingFileName = `${new Date().toISOString().slice(0, 10)}_12-30-00-000.mp4`;
  const recordingBytes = Buffer.from('camera-video');
  await fs.writeFile(path.join(cameraDirectory, recordingFileName), recordingBytes);
  await run("UPDATE managed_cameras SET release_status = 'pending' WHERE id = ?", [camera.id]);

  const recordingsResponse = await fetch(
    `${appUrl}api/cameras/${encodeURIComponent(camera.id)}/recordings`,
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(recordingsResponse.status, 200);
  const recordings = await recordingsResponse.json();
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0].fileName, recordingFileName);

  const downloadResponse = await fetch(
    `${appUrl}api/cameras/${encodeURIComponent(camera.id)}/recordings/${encodeURIComponent(recordingFileName)}`,
    {
      headers: { Authorization: `Bearer ${ownerToken}`, Range: 'bytes=0-5' },
    }
  );
  assert.equal(downloadResponse.status, 206);
  assert.deepEqual(
    Buffer.from(await downloadResponse.arrayBuffer()),
    recordingBytes.subarray(0, 6)
  );

  const unauthorizedRecordingResponse = await fetch(
    `${appUrl}api/cameras/${encodeURIComponent(camera.id)}/recordings`,
    { headers: { Authorization: `Bearer ${otherToken}` } }
  );
  assert.equal(unauthorizedRecordingResponse.status, 404);

  const evidenceResponse = await fetch(
    `${appUrl}api/cameras/${encodeURIComponent(camera.id)}/report-evidence`,
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );
  assert.equal(evidenceResponse.status, 200);
  assert.equal(evidenceResponse.headers.get('content-disposition').startsWith('attachment;'), true);
  assert.deepEqual(Buffer.from(await evidenceResponse.arrayBuffer()), pdf);

  const otherEvidenceResponse = await fetch(
    `${appUrl}api/cameras/${encodeURIComponent(camera.id)}/report-evidence`,
    { headers: { Authorization: `Bearer ${otherToken}` } }
  );
  assert.equal(otherEvidenceResponse.status, 404);

  const feedbackResponse = await fetch(`${appUrl}api/reputation/feedback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment: 'O Guardian está fácil de usar.' }),
  });
  assert.equal(feedbackResponse.status, 200);

  const otherFeedbackResponse = await fetch(`${appUrl}api/reputation/feedback`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  assert.equal((await otherFeedbackResponse.json()).comment, '');

  const reputationResponse = await fetch(`${appUrl}api/reputation`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const reputation = await reputationResponse.json();
  assert.equal(reputation.score, 15);
  assert.equal(reputation.level, 'Participante');
  assert.equal(reputation.achievements[0].id, 'first-camera');
});
