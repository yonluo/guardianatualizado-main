const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const {
  addCameraPath,
  fetchHlsResource,
  getHlsBaseUrl,
  getRetentionDays,
} = require('../src/services/mediaMtx');

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

test('provisions an RTSP path with recording and the configured retention', async (t) => {
  const previous = {
    MEDIAMTX_API_URL: process.env.MEDIAMTX_API_URL,
    MEDIAMTX_API_USER: process.env.MEDIAMTX_API_USER,
    MEDIAMTX_API_PASSWORD: process.env.MEDIAMTX_API_PASSWORD,
    MEDIAMTX_RECORDINGS_PATH: process.env.MEDIAMTX_RECORDINGS_PATH,
    CAMERA_RECORDING_RETENTION_DAYS: process.env.CAMERA_RECORDING_RETENTION_DAYS,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let request;
  process.env.MEDIAMTX_API_URL = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }, t);
  process.env.MEDIAMTX_API_USER = 'api-user';
  process.env.MEDIAMTX_API_PASSWORD = 'api-password';
  process.env.MEDIAMTX_RECORDINGS_PATH = '/data/guardian-recordings';
  process.env.CAMERA_RECORDING_RETENTION_DAYS = '30';

  await addCameraPath('guardian-camera', 'rtsp://user:secret@192.168.10.25:554/live');

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v3/config/paths/add/guardian-camera');
  assert.equal(
    request.authorization,
    `Basic ${Buffer.from('api-user:api-password').toString('base64')}`
  );
  assert.equal(request.body.source, 'rtsp://user:secret@192.168.10.25:554/live');
  assert.equal(request.body.sourceOnDemand, false);
  assert.equal(request.body.record, true);
  assert.equal(request.body.recordFormat, 'fmp4');
  assert.equal(request.body.recordDeleteAfter, '30d');
  assert.equal(
    request.body.recordPath,
    '/data/guardian-recordings/guardian-camera/%Y-%m-%d_%H-%M-%S-%f'
  );
});

test('proxies only the configured HLS server with read credentials and byte ranges', async (t) => {
  const previous = {
    MEDIAMTX_HLS_URL: process.env.MEDIAMTX_HLS_URL,
    MEDIAMTX_HLS_USER: process.env.MEDIAMTX_HLS_USER,
    MEDIAMTX_HLS_PASSWORD: process.env.MEDIAMTX_HLS_PASSWORD,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let request;
  process.env.MEDIAMTX_HLS_URL = await startServer((req, res) => {
    request = { url: req.url, authorization: req.headers.authorization, range: req.headers.range };
    res.writeHead(206, { 'Content-Range': 'bytes 2-4/10', 'Content-Type': 'video/mp4' });
    res.end('234');
  }, t);
  process.env.MEDIAMTX_HLS_USER = 'read-user';
  process.env.MEDIAMTX_HLS_PASSWORD = 'read-password';

  const { response, target } = await fetchHlsResource('guardian-camera', 'segment_001.m4s', {
    range: 'bytes=2-4',
  });

  assert.equal(target.pathname, '/guardian-camera/segment_001.m4s');
  assert.equal(request.url, '/guardian-camera/segment_001.m4s');
  assert.equal(
    request.authorization,
    `Basic ${Buffer.from('read-user:read-password').toString('base64')}`
  );
  assert.equal(request.range, 'bytes=2-4');
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '234');
});

test('enforces a maximum recording retention of 30 days', (t) => {
  const previous = process.env.CAMERA_RECORDING_RETENTION_DAYS;
  t.after(() => {
    if (previous === undefined) delete process.env.CAMERA_RECORDING_RETENTION_DAYS;
    else process.env.CAMERA_RECORDING_RETENTION_DAYS = previous;
  });
  process.env.CAMERA_RECORDING_RETENTION_DAYS = '31';
  assert.throws(getRetentionDays, /between 1 and 30/);
});

test('allows plain HTTP only for explicitly trusted internal MediaMTX hosts', (t) => {
  const previous = {
    MEDIAMTX_HLS_URL: process.env.MEDIAMTX_HLS_URL,
    MEDIAMTX_INTERNAL_HOSTS: process.env.MEDIAMTX_INTERNAL_HOSTS,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.MEDIAMTX_HLS_URL = 'http://mediamtx:8888';
  process.env.MEDIAMTX_INTERNAL_HOSTS = 'mediamtx';
  assert.equal(getHlsBaseUrl().hostname, 'mediamtx');

  process.env.MEDIAMTX_INTERNAL_HOSTS = '';
  assert.throws(getHlsBaseUrl, /HTTPS and an explicitly allowed host/);
});
