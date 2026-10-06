// Images for events and promotions. An image is either a link the organizer
// pastes (image_url) or a file they upload (image_data + image_mime, stored in
// MySQL so it survives on hosts with no writable disk, such as Vercel).
const { HttpError } = require('./errors');

const MAX_BYTES = 2 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Read the image fields of a request body.
 *   { image_url: "https://..." }               → a link
 *   { image_data: "data:image/png;base64,..." } → an uploaded file
 *   neither (or both null)                      → no image
 * Returns the column values to store; the two kinds clear each other.
 */
function parseImage(body) {
  const url = body.image_url == null ? '' : String(body.image_url).trim();
  const data = body.image_data == null ? '' : String(body.image_data);
  if (url && data) throw new HttpError(400, 'Send either image_url or image_data, not both.');

  if (url) {
    if (url.length > 2048) throw new HttpError(400, 'image_url must be at most 2048 characters.');
    let parsed;
    try { parsed = new URL(url); } catch { throw new HttpError(400, 'image_url is not a valid link.'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new HttpError(400, 'image_url must start with http:// or https://.');
    return { image_url: url, image_data: null, image_mime: null };
  }
  if (data) {
    const m = data.match(DATA_URL_RE);
    if (!m) throw new HttpError(400, 'image_data must be a PNG, JPEG, WebP or GIF file.');
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length) throw new HttpError(400, 'image_data is empty.');
    if (bytes.length > MAX_BYTES) throw new HttpError(400, 'The image must be 2 MB or smaller.');
    return { image_url: null, image_data: bytes, image_mime: m[1] };
  }
  return { image_url: null, image_data: null, image_mime: null };
}

/**
 * SQL for the image_src column every listing returns: the uploaded file's URL
 * (with a version so a changed image is not served from cache), else the link.
 * `alias.idColumn` is the row's primary key; `path` is e.g. "events".
 */
const imageSrc = (alias, path, idColumn) =>
  `CASE WHEN ${alias}.image_data IS NOT NULL
        THEN CONCAT('/api/${path}/', ${alias}.${idColumn}, '/image?v=', UNIX_TIMESTAMP(${alias}.image_updated_at))
        ELSE ${alias}.image_url END AS image_src`;

// Send a stored image file. Versioned URLs never change content, so cache hard.
function sendImage(res, row) {
  if (!row || !row.image_data) throw new HttpError(404, 'No uploaded image.');
  res.set('Content-Type', row.image_mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(row.image_data);
}

module.exports = { parseImage, imageSrc, sendImage };
