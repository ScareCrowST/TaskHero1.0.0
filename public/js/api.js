// Thin fetch wrapper. Every mutating request carries the X-TaskHero header (CSRF guard).
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(method, url, body) {
  const opts = { method, headers: { 'X-TaskHero': '1' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, 'Cannot reach the TaskHero server. Is it still running?'); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`);
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u, b) => request('DELETE', u, b),
  async upload(url, file) {
    let res;
    try {
      res = await fetch(`${url}?name=${encodeURIComponent(file.name)}`, {
        method: 'PUT', credentials: 'same-origin', body: file,
        headers: { 'X-TaskHero': '1', 'Content-Type': 'application/octet-stream' },
      });
    } catch { throw new ApiError(0, 'Upload failed. The file may be too large.'); }
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Upload failed (${res.status}).`);
    return data;
  },
};
