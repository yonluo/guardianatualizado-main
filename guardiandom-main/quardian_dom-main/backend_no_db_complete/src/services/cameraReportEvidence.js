const path = require('node:path');

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const allowedReportTypes = new Map([
  ['application/pdf', ['.pdf']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/png', ['.png']],
  ['image/webp', ['.webp']],
  ['video/mp4', ['.mp4']],
  ['video/webm', ['.webm']],
]);

function invalidEvidence(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function matchesSignature(mimeType, data) {
  if (mimeType === 'application/pdf') return data.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/jpeg')
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png')
    return data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp')
    return (
      data.length >= 12 &&
      data.subarray(0, 4).toString() === 'RIFF' &&
      data.subarray(8, 12).toString() === 'WEBP'
    );
  if (mimeType === 'video/mp4')
    return data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp';
  if (mimeType === 'video/webm')
    return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

function validateCameraReportEvidence(file) {
  if (
    !file ||
    typeof file.mimeType !== 'string' ||
    typeof file.fileName !== 'string' ||
    typeof file.data !== 'string'
  ) {
    throw invalidEvidence('Anexe o BO em PDF, JPG, PNG, WebP, MP4 ou WebM.');
  }
  const extensions = allowedReportTypes.get(file.mimeType);
  const safeFileName = path
    .basename(file.fileName.replace(/\\/g, '/'))
    .replace(/[\r\n"]/g, '')
    .slice(0, 255);
  if (!extensions || !extensions.includes(path.extname(safeFileName).toLowerCase())) {
    throw invalidEvidence(
      'O formato do arquivo não corresponde a PDF, JPG, PNG, WebP, MP4 ou WebM.'
    );
  }
  if (file.data.length > Math.ceil((MAX_REPORT_BYTES * 4) / 3) + 8) {
    const error = invalidEvidence('O arquivo do BO deve ter até 10 MB.');
    error.status = 413;
    throw error;
  }
  const data = Buffer.from(file.data, 'base64');
  if (
    data.length === 0 ||
    data.length > MAX_REPORT_BYTES ||
    data.toString('base64') !== file.data
  ) {
    throw invalidEvidence('O arquivo do BO é inválido ou excede o limite de 10 MB.');
  }
  if (!matchesSignature(file.mimeType, data)) {
    throw invalidEvidence('O conteúdo do arquivo não corresponde ao formato informado.');
  }
  return { fileName: safeFileName, mimeType: file.mimeType, data };
}

module.exports = { MAX_REPORT_BYTES, validateCameraReportEvidence };
