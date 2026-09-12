// SKA Helpdesk - Drive attachment service.
// Keyless Google auth via the same chain as the mail runner:
//   Vercel OIDC -> GCP STS -> iamcredentials signJwt (DWD, impersonating info@) -> Drive token.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const SHARED_DRIVE_ID = '0ABzkS40WEE15Uk9PVA';
const DRIVE_USER = 'info@singlekeyadvisory.com';
const crypto = require('crypto');

function fail(msg) { throw new Error(msg); }

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-drain-secret');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const need = k => { const v = process.env[k]; if (!v) fail('Not configured: ' + k); return v; };
    const AUD = need('GCP_WIF_AUDIENCE'), SA = need('GCP_SERVICE_ACCOUNT');
    const SUPA = need('SUPABASE_URL').replace(/\/$/, ''), KEY = need('SUPABASE_SERVICE_ROLE_KEY');

    const sb = async (path, opts = {}) => {
      const r = await fetch(`${SUPA}${path}`, { ...opts, headers: {
        apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
        'accept-profile': 'helpdesk', 'content-profile': 'helpdesk', ...(opts.headers || {}) } });
      const t = await r.text();
      if (!r.ok) fail(`DB ${path} ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };
    const stDown = async (p) => {
      const r = await fetch(`${SUPA}/storage/v1/object/helpdesk-attachments/${p}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
      if (!r.ok) return null; return Buffer.from(await r.arrayBuffer());
    };
    const stDel = async (p) => { await fetch(`${SUPA}/storage/v1/object/helpdesk-attachments/${p}`, { method: 'DELETE', headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }).catch(() => {}); };

    const oidc = process.env.VERCEL_OIDC_TOKEN || req.headers['x-vercel-oidc-token'];
    if (!oidc) fail('No Vercel identity token (enable OIDC federation on this project).');
    const stsR = await fetch('https://sts.googleapis.com/v1/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audience: AUD, grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', subjectToken: oidc }) });
    if (!stsR.ok) fail('STS refused: ' + (await stsR.text()).slice(0, 200));
    const sts = (await stsR.json()).access_token;
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: SA, sub: DRIVE_USER, scope: DRIVE_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
    const sjR = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`, {
      method: 'POST', headers: { authorization: `Bearer ${sts}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify(claims) }) });
    if (!sjR.ok) fail('signJwt failed: ' + (await sjR.text()).slice(0, 200));
    const signed = (await sjR.json()).signedJwt;
    const tR = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(signed)}` });
    const tj = await tR.json();
    if (!tR.ok || !tj.access_token) fail('Drive delegation refused for ' + DRIVE_USER + ': ' + JSON.stringify(tj).slice(0, 200));
    const TOK = tj.access_token;

    const driveUpload = async (name, mime, bytes) => {
      const boundary = 'b' + Math.random().toString(36).slice(2);
      const meta = { name: name || 'attachment', parents: [SHARED_DRIVE_ID] };
      const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`;
      const post = `\r\n--${boundary}--`;
      const body = Buffer.concat([Buffer.from(pre, 'utf8'), bytes, Buffer.from(post, 'utf8')]);
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
        method: 'POST', headers: { authorization: `Bearer ${TOK}`, 'content-type': `multipart/related; boundary=${boundary}` }, body });
      const j = await r.json();
      if (!r.ok || !j.id) fail('Drive upload failed: ' + JSON.stringify(j).slice(0, 200));
      return j.id;
    };
    const driveGet = async (id) => {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${TOK}` } });
      if (!r.ok) return null; return Buffer.from(await r.arrayBuffer());
    };
    const driveDel = async (id) => { await fetch(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true`, { method: 'DELETE', headers: { authorization: `Bearer ${TOK}` } }).catch(() => {}); };

    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action');
    const secretOk = async () => { const c = (await sb('/rest/v1/push_config?id=eq.1&select=drain_secret'))[0]; return c && req.headers['x-drain-secret'] === c.drain_secret; };

    if (action === 'validate') {
      if (!await secretOk()) { res.status(403).json({ error: 'forbidden' }); return; }
      const id = await driveUpload('ska-drive-probe.txt', 'text/plain', Buffer.from('ok ' + new Date().toISOString()));
      const back = await driveGet(id);
      await driveDel(id);
      res.status(200).json({ ok: true, uploaded: id, read_ok: !!back && back.toString().startsWith('ok') });
      return;
    }

    if (action === 'migrate') {
      if (!await secretOk()) { res.status(403).json({ error: 'forbidden' }); return; }
      const t0 = Date.now();
      const limit = Math.min(300, parseInt(url.searchParams.get('limit') || '60', 10));
      const rows = await sb(`/rest/v1/attachments?storage_path=not.is.null&drive_file_id=is.null&select=id,filename,mime_type,storage_path&limit=${limit}`);
      let moved = 0, cleared = 0, failed = 0;
      for (const a of rows) {
        if (Date.now() - t0 > 240000) break;
        try {
          const bytes = await stDown(a.storage_path);
          if (!bytes) {
            await sb(`/rest/v1/attachments?id=eq.${a.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ storage_path: null }) });
            cleared++; continue;
          }
          const fid = await driveUpload(a.filename, a.mime_type, bytes);
          await sb(`/rest/v1/attachments?id=eq.${a.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ drive_file_id: fid, storage_path: null }) });
          await stDel(a.storage_path);
          moved++;
        } catch (e) { failed++; }
      }
      const remain = (await sb(`/rest/v1/attachments?storage_path=not.is.null&drive_file_id=is.null&select=id&limit=1`)).length;
      res.status(200).json({ ok: true, moved, cleared, failed, more: remain > 0 });
      return;
    }

    const att = url.searchParams.get('att');
    if (att) {
      const exp = url.searchParams.get('exp');
      const sig = url.searchParams.get('sig');
      const dl  = url.searchParams.get('dl') === '1';
      let a = null;

      if (exp && sig) {
        // signed mode: HMAC over "<att>.<exp>" with the shared drain secret; no JWT needed
        // (this lets Google's Docs viewer fetch the file server-side)
        if (Number(exp) * 1000 < Date.now()) { res.status(403).json({ error: 'link expired' }); return; }
        const cfg = await sb(`/rest/v1/push_config?id=eq.1&select=drain_secret`);
        const secret = cfg && cfg[0] && cfg[0].drain_secret;
        if (!secret) { res.status(500).json({ error: 'no secret' }); return; }
        const want = crypto.createHmac('sha256', secret).update(att + '.' + exp).digest('hex');
        const ok = sig.length === want.length &&
          crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
        if (!ok) { res.status(403).json({ error: 'bad signature' }); return; }
        const rows = await sb(`/rest/v1/attachments?id=eq.${att}&select=filename,mime_type,drive_file_id,storage_path`);
        a = rows && rows[0];
      } else {
        // JWT mode: verify the caller is a member of the attachment's tenant
        const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        let uid = null;
        if (bearer) { const uR = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: KEY, authorization: `Bearer ${bearer}` } }); if (uR.ok) { const u = await uR.json(); uid = u && u.id; } }
        if (!uid) { res.status(401).json({ error: 'unauthorized' }); return; }
        const rows = await sb(`/rest/v1/attachments?id=eq.${att}&select=filename,mime_type,drive_file_id,storage_path,messages!inner(tenant_id)`);
        const row = rows && rows[0];
        if (!row) { res.status(404).json({ error: 'not found' }); return; }
        const ten = row.messages && row.messages.tenant_id;
        const mem = await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${uid}&tenant_id=eq.${ten}&select=user_id&limit=1`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'public' } });
        const okMem = mem.ok && (await mem.json()).length > 0;
        if (!okMem) { res.status(403).json({ error: 'forbidden' }); return; }
        a = row;
      }

      if (!a) { res.status(404).json({ error: 'not found' }); return; }
      let bytes = null;
      if (a.drive_file_id) bytes = await driveGet(a.drive_file_id);
      else if (a.storage_path) bytes = await stDown(a.storage_path);
      if (!bytes) { res.status(404).json({ error: 'file gone' }); return; }

      const fn = a.filename || 'file';
      const ascii = fn.replace(/[\x00-\x1f\x7f-\uffff"\\]/g, '_');  // safe fallback, original name preserved below
      const star = encodeURIComponent(fn).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      res.setHeader('content-type', a.mime_type || 'application/octet-stream');
      res.setHeader('content-disposition', `${dl ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${star}`);
      res.setHeader('cache-control', 'private, max-age=300');
      res.status(200).end(bytes);
      return;
    }

    res.status(400).json({ error: 'no action' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
