function configurationError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function getBaseUrl(variable, label) {
  const value = process.env[variable];
  if (!value) throw configurationError(`${variable} is required to enable ${label}.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(`${variable} must be a valid URL.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw configurationError(`${variable} must be an HTTP(S) URL without embedded credentials.`);
  }
  const allowedHosts = (process.env.MEDIAMTX_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const internalHosts = (process.env.MEDIAMTX_INTERNAL_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase());
  const trustedInternalHttpHost =
    url.protocol === 'http:' && internalHosts.includes(url.hostname.toLowerCase());
  if (
    !localHost &&
    !trustedInternalHttpHost &&
    (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname.toLowerCase()))
  ) {
    throw configurationError(
      `${variable} must use HTTPS and an explicitly allowed host when MediaMTX is remote.`
    );
  }
  return url;
}

function getApiCredentials() {
  const username = process.env.MEDIAMTX_API_USER || '';
  const password = process.env.MEDIAMTX_API_PASSWORD || '';
  if (!username || !password)
    throw configurationError('MediaMTX API credentials are not configured.');
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function getRetentionDays() {
  const days = Number(process.env.CAMERA_RECORDING_RETENTION_DAYS || '30');
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw configurationError('CAMERA_RECORDING_RETENTION_DAYS must be between 1 and 30.');
  }
  return days;
}

async function mediaRequest(path, { method = 'GET', body, baseUrl } = {}) {
  const base = baseUrl || getBaseUrl('MEDIAMTX_API_URL', 'camera integration');
  const headers = { Authorization: getApiCredentials() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(new URL(path, base), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(7000),
    });
  } catch {
    throw new Error('Não foi possível conectar à API privada do MediaMTX.');
  }
  if (!response.ok) {
    const error = new Error(`MediaMTX respondeu com HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function pathNameUrl(pathName) {
  return `/v3/config/paths/${pathName}`;
}

async function addCameraPath(pathName, source) {
  const recordingPath = process.env.MEDIAMTX_RECORDINGS_PATH;
  if (!recordingPath) {
    throw configurationError('MEDIAMTX_RECORDINGS_PATH is required to enable recordings.');
  }
  const retentionDays = getRetentionDays();
  return mediaRequest(`/v3/config/paths/add/${encodeURIComponent(pathName)}`, {
    method: 'POST',
    body: {
      source,
      sourceOnDemand: false,
      record: true,
      recordPath: `${recordingPath.replace(/[\\/]+$/, '')}/${pathName}/%Y-%m-%d_%H-%M-%S-%f`,
      recordFormat: 'fmp4',
      recordSegmentDuration: '1h',
      recordDeleteAfter: `${retentionDays}d`,
    },
  });
}

async function removeCameraPath(pathName) {
  try {
    return await mediaRequest(`${pathNameUrl('delete')}/${encodeURIComponent(pathName)}`, {
      method: 'DELETE',
    });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function getCameraPathStatus(pathName) {
  try {
    return await mediaRequest(`/v3/paths/get/${encodeURIComponent(pathName)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function getHlsBaseUrl() {
  return getBaseUrl('MEDIAMTX_HLS_URL', 'live playback');
}

function getHlsCredentials() {
  const username = process.env.MEDIAMTX_HLS_USER || '';
  const password = process.env.MEDIAMTX_HLS_PASSWORD || '';
  if (!username || !password)
    throw configurationError('MediaMTX HLS credentials are not configured.');
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function fetchHlsResource(pathName, resource, requestHeaders = {}) {
  const base = getHlsBaseUrl();
  const target = new URL(base);
  target.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(pathName)}/${resource
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  target.search = '';
  let response;
  try {
    response = await fetch(target, {
      headers: {
        Authorization: getHlsCredentials(),
        ...(requestHeaders.range ? { Range: requestHeaders.range } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Não foi possível carregar a transmissão HLS.');
  }
  return { response, target };
}

module.exports = {
  addCameraPath,
  fetchHlsResource,
  getCameraPathStatus,
  getHlsBaseUrl,
  getHlsCredentials,
  getRetentionDays,
  mediaRequest,
  removeCameraPath,
};
