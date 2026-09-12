// SKA Helpdesk mail runner v2.
// Keyless: Vercel OIDC -> GCP STS -> iamcredentials signJwt (DWD) -> Gmail token.
// No key file exists anywhere. Inbound: Gmail -> helpdesk schema, with per-mailbox
// checkpoints. Outbound: queued replies with Cc, Bcc and attachments.
// Every failure names the setup step that caused it.

const SCOPES = 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send';
// in:anywhere pulls EVERYTHING - inbox, spam, promotions, social, updates, sent.
// One full year, matching the retention deletion window - older mail would be
// deleted by retention immediately anyway.
const FIRST_SYNC_WINDOW = 'newer_than:365d in:anywhere -in:chats -in:trash';
const MAX_IDS_PER_RUN = 400;          // per mailbox
const MAX_ATT_BYTES = 20 * 1024 * 1024;
const BUDGET_MS = 280000;             // leave headroom under maxDuration 300s

function fail(msg, fix) { const e = new Error(msg); e.fix = fix; throw e; }

module.exports = async (req, res) => {
  const t0 = Date.now();
  const left = () => BUDGET_MS - (Date.now() - t0);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    // ---- config -----------------------------------------------------------
    const need = k => {
      const v = process.env[k];
      if (!v) fail(`Not configured yet: ${k}`, 'Add it in Vercel -> Settings -> Environment Variables, then redeploy.');
      return v;
    };
    const SECRET = need('CRON_SECRET');
    const AUD = need('GCP_WIF_AUDIENCE');
    const SA = need('GCP_SERVICE_ACCOUNT');
    const SUPA = need('SUPABASE_URL').replace(/\/$/, '');
    const KEY = need('SUPABASE_SERVICE_ROLE_KEY');

    // Auth: the cron secret, OR a signed-in staff member's own session token
    // (that is what the "Sync now" button sends - no secret ever ships to the browser).
    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (bearer !== SECRET) {
      let okUser = false;
      if (bearer) {
        const uR = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: KEY, authorization: `Bearer ${bearer}` } });
        if (uR.ok) {
          const u = await uR.json();
          if (u?.id) {
            const mR = await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${u.id}&select=user_id&limit=1`,
              { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'public' } });
            okUser = mR.ok && (await mR.json()).length > 0;
          }
        }
      }
      if (!okUser) { res.status(401).json({ error: 'unauthorized' }); return; }
    }

    // ---- supabase REST helpers -------------------------------------------
    const sb = async (path, opts = {}) => {
      const r = await fetch(`${SUPA}${path}`, {
        ...opts,
        headers: {
          apikey: KEY, authorization: `Bearer ${KEY}`,
          'content-type': 'application/json',
          'accept-profile': 'helpdesk', 'content-profile': 'helpdesk',
          ...(opts.headers || {})
        }
      });
      const txt = await r.text();
      if (!r.ok) fail(`Database error on ${path}: ${txt.slice(0, 300)}`);
      return txt ? JSON.parse(txt) : null;
    };
    const stUp = async (path, bytes, mime) => {
      const r = await fetch(`${SUPA}/storage/v1/object/helpdesk-attachments/${path}`, {
        method: 'POST',
        headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': mime || 'application/octet-stream', 'x-upsert': 'true' },
        body: bytes
      });
      return r.ok;
    };
    const stDown = async (path) => {
      const r = await fetch(`${SUPA}/storage/v1/object/helpdesk-attachments/${path}`, {
        headers: { apikey: KEY, authorization: `Bearer ${KEY}` }
      });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    };

    // ---- identity chain ---------------------------------------------------
    const oidc = process.env.VERCEL_OIDC_TOKEN || req.headers['x-vercel-oidc-token'];
    if (!oidc) fail('No Vercel identity token',
      'Step 4 - enable Settings -> Security -> OIDC Federation (team issuer mode) on this project, then redeploy.');

    const stsR = await fetch('https://sts.googleapis.com/v1/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audience: AUD,
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
        subjectToken: oidc
      })
    });
    if (!stsR.ok) fail(`Google would not accept this site's identity: ${(await stsR.text()).slice(0, 300)}`,
      'Step 2 - check issuer URL, allowed audience and the attribute condition on the workload identity provider.');
    const sts = (await stsR.json()).access_token;

    const tokenCache = {};
    const gmailToken = async (mailbox) => {
      if (tokenCache[mailbox]) return tokenCache[mailbox];
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: SA, sub: mailbox, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
      const sR = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`, {
        method: 'POST', headers: { authorization: `Bearer ${sts}`, 'content-type': 'application/json' },
        body: JSON.stringify({ payload: JSON.stringify(claims) })
      });
      if (!sR.ok) fail(`signJwt failed: ${(await sR.text()).slice(0, 300)}`,
        'Step 2 - the Token Creator grant on the service account, or the IAM Service Account Credentials API from step 1.3.');
      const signed = (await sR.json()).signedJwt;
      const tR = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(signed)}`
      });
      const tj = await tR.json();
      if (!tR.ok || !tj.access_token) fail(`Delegation refused for ${mailbox}: ${JSON.stringify(tj).slice(0, 300)}`,
        'Step 3 - domain-wide delegation in admin.google.com. Client ID and both scopes must match character for character. Changes can take a few minutes to apply.');
      tokenCache[mailbox] = tj.access_token;
      return tj.access_token;
    };

    const g = async (tok, path, ok404) => {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { authorization: `Bearer ${tok}` } });
      if (r.status === 404 && ok404) return null;
      if (!r.ok) fail(`Gmail error on ${path.split('?')[0]}: ${(await r.text()).slice(0, 300)}`);
      return r.json();
    };

    // ---- load inboxes -----------------------------------------------------
    const inboxes = await sb('/rest/v1/inboxes?is_active=eq.true&select=*');
    const PRIORITY = ['sales@', 'rishab@', 'mis@', 'support@', 'info@'];
    inboxes.sort((a, b) => {
      const ah = a.last_history_id ? 0 : 1, bh = b.last_history_id ? 0 : 1;
      if (ah !== bh) return ah - bh;
      const ai = PRIORITY.findIndex(p => a.email_address.startsWith(p));
      const bi = PRIORITY.findIndex(p => b.email_address.startsWith(p));
      return ai - bi;
    });
    const ownAddrs = new Set(inboxes.map(i => i.email_address.toLowerCase()));

    // ---- inbound ----------------------------------------------------------
    // Two passes so a long backfill can never starve fresh mail:
    //   Pass 1  new mail for EVERY mailbox (incremental via historyId, or a bounded
    //           newest-window seed on first contact). The incremental cursor is set
    //           on the first run, so new mail always appears within one cycle.
    //   Pass 2  older mail backfilled with whatever budget is left, bounded per box,
    //           walking a `before:` cursor until the whole year is in.
    const report = [];
    // Automatic (cron) runs honor the tenant's configured sync interval; manual "Sync now" always runs.
    let skipInbound = false;
    if (bearer === SECRET) {
      const tsRows = await sb('/rest/v1/tenant_settings?select=sync_interval_minutes');
      const intervalMin = (Array.isArray(tsRows) && tsRows.length) ? Math.min(...tsRows.map(r => r.sync_interval_minutes || 10)) : 10;
      const lastSynced = Math.max(0, ...inboxes.map(i => i.last_synced_at ? Date.parse(i.last_synced_at) : 0));
      if (intervalMin > 10 && lastSynced && (Date.now() - lastSynced) < intervalMin * 60000) skipInbound = true;
    }
    const gmailDate = iso => { const d = new Date(new Date(iso).getTime() + 86400000); const p = n => String(n).padStart(2, '0');
      return d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()); }; // boundary day + older; dedup drops repeats

    // Ingest a list of Gmail message ids. Returns {n, oldest} where oldest is the
    // earliest sent_at actually ingested (ISO) or null. Stops if the deadline passes.
    const ingestIds = async (inbox, tok, ids, deadline) => {
      let n = 0, oldest = null, seen = 0;
      ids = [...new Set(ids)];
      for (const id of ids) {
        if (left() < deadline) break;
        seen++;
        const full = await g(tok, `/messages/${id}?format=full`, true);
        if (!full) { seen--; continue; }   // fetch failed: leave the cursor parked so we retry
        if ((full.labelIds || []).includes('DRAFT')) continue;
        const H = {}; (full.payload?.headers || []).forEach(h => H[h.name.toLowerCase()] = h.value);
        const fm = /^(.*?)\s*<(.+@.+)>\s*$/.exec(H.from || '') || [];
        const fromEmail = (fm[2] || H.from || '').trim().replace(/^<|>$/g, '');
        const fromName = (fm[1] || '').replace(/^"|"$/g, '').trim() || null;
        const splitA = str => (str || '').split(',').map(x => { const m2 = /<(.+@.+)>/.exec(x); return (m2 ? m2[1] : x).trim(); }).filter(x => x.includes('@'));
        const refs = (H.references || '').split(/\s+/).filter(Boolean);
        let text = '', html = '', atts = [];
        const walk = p => {
          if (!p) return;
          if (p.filename && p.body?.attachmentId) atts.push({ filename: p.filename, mime: p.mimeType, size: p.body.size || 0, aid: p.body.attachmentId });
          else if (p.mimeType === 'text/plain' && p.body?.data && !text) text = Buffer.from(p.body.data, 'base64url').toString('utf8');
          else if (p.mimeType === 'text/html' && p.body?.data && !html) html = Buffer.from(p.body.data, 'base64url').toString('utf8');
          (p.parts || []).forEach(walk);
        };
        walk(full.payload);
        const thr = await sb('/rest/v1/rpc/resolve_thread', { method: 'POST',
          body: JSON.stringify({ p_tenant: inbox.tenant_id, p_gmail_thread_id: full.threadId, p_inbox_id: inbox.id,
            p_subject: H.subject || '(no subject)', p_rfc_message_id: H['message-id'] || null, p_references: refs }) });
        const labels = full.labelIds || [];
        const isSent = labels.includes('SENT') && ownAddrs.has(fromEmail.toLowerCase());
        const sentAt = new Date(Number(full.internalDate || Date.now())).toISOString();
        const ins = await sb('/rest/v1/messages?on_conflict=gmail_message_id&select=id', { method: 'POST',
          headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify([{ tenant_id: inbox.tenant_id, thread_id: thr, gmail_message_id: full.id,
            rfc_message_id: H['message-id'] || null, direction: isSent ? 'outbound' : 'inbound',
            classification: isSent ? 'help' : 'unclassified', from_email: fromEmail, from_name: fromName,
            to_emails: splitA(H.to), cc_emails: splitA(H.cc), subject: H.subject || '(no subject)',
            snippet: (full.snippet || '').slice(0, 500), body_text: text || null, body_html: html || null,
            sent_at: sentAt, has_attachments: atts.length > 0,
            headers: { 'in-reply-to': H['in-reply-to'] || null, references: refs, labels } }]) });
        if (!ins || !ins.length) continue;
        const msgId = ins[0].id; n++;
        if (!oldest || sentAt < oldest) oldest = sentAt;
        for (const a of atts) {
          let path = null;
          if (a.size <= MAX_ATT_BYTES && left() > 20000) {
            const ar = await g(tok, `/messages/${id}/attachments/${a.aid}`, true);
            if (ar?.data) { const bytes = Buffer.from(ar.data, 'base64url'); const safe = a.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 140);
              if (await stUp(`${msgId}/${safe}`, bytes, a.mime)) path = `${msgId}/${safe}`; }
          }
          await sb('/rest/v1/attachments', { method: 'POST', headers: { prefer: 'return=minimal' },
            body: JSON.stringify([{ message_id: msgId, filename: a.filename, mime_type: a.mime, size_bytes: a.size,
              gmail_attachment_id: a.aid, storage_path: path, downloaded_at: path ? new Date().toISOString() : null }]) });
        }
      }
      return { n, oldest, complete: seen === ids.length };
    };

    // ===== Pass 1: fresh mail for every mailbox ============================
    for (const inbox of (skipInbound ? [] : inboxes)) {
      if (left() < 20000) { report.push({ mailbox: inbox.email_address, note: 'skipped - out of time, next run' }); continue; }
      const summary = { mailbox: inbox.email_address, ingested: 0 };
      try {
        const tok = await gmailToken(inbox.email_address);
        const profile = await g(tok, '/profile');           // historyId snapshot BEFORE listing
        let ids = [], haveCursor = !!inbox.last_history_id, seeded = false;

        if (haveCursor) {
          let page = '', guard = 0;
          while (guard++ < 30) {
            const h = await g(tok, `/history?startHistoryId=${inbox.last_history_id}&historyTypes=messageAdded&maxResults=100${page ? `&pageToken=${page}` : ''}`, true);
            if (h === null) { haveCursor = false; break; }    // history expired -> reseed
            (h.history || []).forEach(x => (x.messagesAdded || []).forEach(m => ids.push(m.message.id)));
            if (!h.nextPageToken) break; page = h.nextPageToken;
          }
        }

        // Gap safety-net: Gmail's history feed can silently skip a delivered
        // message (often spam-filtered or arriving mid-sync). Every cycle, and
        // only with ample budget, re-list the last 2 days and ingest anything we
        // are missing. The DB is checked first, so only genuine gaps are fetched.
        if (haveCursor && left() > 60000) {
          try {
            let rids = [], rpage = '', rg = 0;
            while (rg++ < 3) {
              const rl = await g(tok, `/messages?q=${encodeURIComponent('newer_than:2d in:anywhere -in:chats -in:trash')}&includeSpamTrash=true&maxResults=100${rpage ? `&pageToken=${rpage}` : ''}`);
              (rl.messages || []).forEach(m => rids.push(m.id));
              if (!rl.nextPageToken) break; rpage = rl.nextPageToken;
            }
            if (rids.length) {
              const have = new Set();
              for (let i = 0; i < rids.length; i += 100) {
                const chunk = rids.slice(i, i + 100);
                const rows = await sb(`/rest/v1/messages?select=gmail_message_id&gmail_message_id=in.(${chunk.join(',')})`);
                (rows || []).forEach(r => r.gmail_message_id && have.add(r.gmail_message_id));
              }
              const seen = new Set(ids);
              for (const x of rids) if (!have.has(x) && !seen.has(x)) ids.push(x);
            }
          } catch (e) { /* reconciliation is best-effort; never block the sync */ }
        }

        if (!haveCursor) {                                     // first contact or expired: seed newest window
          let page = '', guard = 0;
          while (guard++ < 2 && ids.length < 200) {
            const l = await g(tok, `/messages?q=${encodeURIComponent(FIRST_SYNC_WINDOW)}&includeSpamTrash=true&maxResults=100${page ? `&pageToken=${page}` : ''}`);
            (l.messages || []).forEach(m => ids.push(m.id));
            if (!l.nextPageToken) break; page = l.nextPageToken;
          }
          seeded = true;
        }

        const r1 = await ingestIds(inbox, tok, ids, 22000);
        summary.ingested = r1.n;

        const patch = { last_synced_at: new Date().toISOString(), sync_error: null };
        if (seeded || !haveCursor) {
          // Establish the incremental cursor NOW so all future new mail flows,
          // and (if this is the very first sync) arm the backfill for older mail.
          patch.last_history_id = profile.historyId + '';
          if (!inbox.last_history_id && !inbox.backfill_done) {
            patch.backfill_before = r1.oldest || new Date().toISOString();
          }
        } else if (r1.complete) {
          // Advance the cursor. profile.historyId was snapshotted BEFORE listing,
          // so anything that arrived mid-run is still picked up next time. Only
          // safe when ingestion consumed the whole list -- otherwise the ids we
          // ran out of budget for would be skipped forever.
          // Without this the cursor stays pinned where it was first set: the
          // replay window grows every day until it exceeds one run's 22s ingest
          // budget, after which the newest mail is never reached and the mailbox
          // goes quiet with no error at all.
          patch.last_history_id = profile.historyId + '';
        }
        await sb(`/rest/v1/inboxes?id=eq.${inbox.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        // keep local copy current for pass 2
        if (patch.last_history_id) inbox.last_history_id = patch.last_history_id;
        if (patch.backfill_before) inbox.backfill_before = patch.backfill_before;
      } catch (e) {
        summary.error = e.message; summary.fix = e.fix;
        await sb(`/rest/v1/inboxes?id=eq.${inbox.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ sync_error: e.message.slice(0, 400) }) }).catch(() => {});
      }
      report.push(summary);
    }

    // ===== Pass 2: backfill older mail with leftover budget ===============
    const backlog = skipInbound ? [] : inboxes.filter(i => !i.backfill_done);
    for (let bi = 0; bi < backlog.length; bi++) {
      const inbox = backlog[bi];
      if (left() < 40000) break;                              // keep room for outbound + retention
      // Fair share of the remaining budget across the remaining backlog mailboxes.
      const perBox = Math.max(30000, Math.floor((left() - 30000) / (backlog.length - bi)));
      const boxT0 = Date.now();
      const boxLeft = () => Math.min(left(), perBox - (Date.now() - boxT0));
      const rep = report.find(r => r.mailbox === inbox.email_address) || { mailbox: inbox.email_address, ingested: 0 };
      try {
        const tok = await gmailToken(inbox.email_address);
        const before = inbox.backfill_before ? gmailDate(inbox.backfill_before) : gmailDate(new Date().toISOString());
        let ids = [], page = '', guard = 0;
        while (guard++ < 6 && ids.length < 300 && boxLeft() > 20000) {
          const l = await g(tok, `/messages?q=${encodeURIComponent(FIRST_SYNC_WINDOW + ' before:' + before)}&includeSpamTrash=true&maxResults=100${page ? `&pageToken=${page}` : ''}`);
          (l.messages || []).forEach(m => ids.push(m.id));
          if (!l.nextPageToken) break; page = l.nextPageToken;
        }
        if (!ids.length) {
          await sb(`/rest/v1/inboxes?id=eq.${inbox.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ backfill_done: true, backfill_before: null }) });
          rep.backfill = 'done';
        } else {
          const r2 = await ingestIds(inbox, tok, ids, 15000);
          rep.ingested = (rep.ingested || 0) + r2.n;
          rep.backfill = `+${r2.n} older`;
          // Advance strictly: if we ingested new mail, jump the cursor to the oldest ingested.
          // If everything in this batch was a duplicate, step the cursor back one day so the
          // backfill keeps moving older instead of stalling on a heavy day. Only an EMPTY
          // listing (handled above) ends the backfill.
          const curBefore = inbox.backfill_before ? new Date(inbox.backfill_before).getTime() : Date.now();
          const nextBefore = r2.oldest ? r2.oldest : new Date(curBefore - 86400000).toISOString();
          await sb(`/rest/v1/inboxes?id=eq.${inbox.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ backfill_before: nextBefore }) });
          inbox.backfill_before = nextBefore;
        }
        if (!report.includes(rep)) report.push(rep);
      } catch (e) {
        rep.backfill_error = e.message;
        if (!report.includes(rep)) report.push(rep);
      }
    }

    // ---- outbound ---------------------------------------------------------
    const out = { sent: 0, failed: 0 };
    const inboxById = Object.fromEntries(inboxes.map(i => [i.id, i]));
    const queued = (await sb('/rest/v1/outbound_messages?status=eq.queued&select=*&order=created_at.asc&limit=25'))
      .filter(q => Date.now() - new Date(q.created_at).getTime() > 15000);

    const encSubj = s => /[^\x20-\x7e]/.test(s || '') ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : (s || '');
    const b64wrap = b => b.toString('base64').replace(/(.{76})/g, '$1\r\n');

    for (const q of queued) {
      if (left() < 20000) break;
      const inbox = inboxById[q.from_inbox_id];
      if (!inbox) continue;
      try {
        const tok = await gmailToken(inbox.email_address);

        let inReply = q.in_reply_to;
        if (!inReply && q.thread_id) {
          const last = await sb(`/rest/v1/messages?thread_id=eq.${q.thread_id}&direction=eq.inbound&order=sent_at.desc&limit=1&select=rfc_message_id`);
          inReply = last?.[0]?.rfc_message_id || null;
        }
        let gThread = null;
        if (q.thread_id) {
          const tg = await sb(`/rest/v1/thread_gmail_ids?thread_id=eq.${q.thread_id}&inbox_id=eq.${inbox.id}&select=gmail_thread_id&limit=1`);
          gThread = tg?.[0]?.gmail_thread_id || null;
        }
        const files = await sb(`/rest/v1/outbound_attachments?outbound_id=eq.${q.id}&select=*`);

        const bAlt = 'alt_' + q.id.replace(/-/g, '').slice(0, 12);
        const bMix = 'mix_' + q.id.replace(/-/g, '').slice(0, 12);
        let head = `From: ${inbox.email_address}\r\nTo: ${(q.to_emails || []).join(', ')}\r\n`;
        if (q.cc_emails?.length) head += `Cc: ${q.cc_emails.join(', ')}\r\n`;
        if (q.bcc_emails?.length) head += `Bcc: ${q.bcc_emails.join(', ')}\r\n`;
        head += `Subject: ${encSubj(q.subject)}\r\nMIME-Version: 1.0\r\n`;
        if (q.request_receipt) head += `Disposition-Notification-To: ${inbox.email_address}\r\nReturn-Receipt-To: ${inbox.email_address}\r\n`;
        if (inReply) head += `In-Reply-To: ${inReply}\r\nReferences: ${inReply}\r\n`;

        const alt =
          `--${bAlt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
          b64wrap(Buffer.from(q.body_text || '', 'utf8')) + `\r\n` +
          `--${bAlt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
          b64wrap(Buffer.from(q.body_html || `<p>${q.body_text || ''}</p>`, 'utf8')) + `\r\n--${bAlt}--\r\n`;

        let mime;
        if (files?.length) {
          mime = head + `Content-Type: multipart/mixed; boundary="${bMix}"\r\n\r\n` +
            `--${bMix}\r\nContent-Type: multipart/alternative; boundary="${bAlt}"\r\n\r\n` + alt;
          for (const f of files) {
            const bytes = await stDown(f.storage_path);
            if (!bytes) fail(`Attachment missing from storage: ${f.filename}`);
            mime += `--${bMix}\r\nContent-Type: ${f.mime_type || 'application/octet-stream'}; name="${f.filename}"\r\n` +
              `Content-Disposition: attachment; filename="${f.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
              b64wrap(bytes) + `\r\n`;
          }
          mime += `--${bMix}--`;
        } else {
          mime = head + `Content-Type: multipart/alternative; boundary="${bAlt}"\r\n\r\n` + alt;
        }

        const sR = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
          body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url'), ...(gThread ? { threadId: gThread } : {}) })
        });
        const sj = await sR.json();
        if (!sR.ok) throw new Error(`Gmail send failed: ${JSON.stringify(sj).slice(0, 300)}`);

        await sb(`/rest/v1/outbound_messages?id=eq.${q.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString(), gmail_message_id: sj.id })
        });

        // The RFC Message-Id is how a bounce notice is later matched back to
        // this mail. Gmail's send response does not include it, so ask for it.
        // Without it, apply_bounce cannot attribute the failure and the mail
        // keeps a green tick forever -- which is exactly what happened to every
        // reply ever sent from the portal, because messages.thread_id is NOT
        // NULL so only replies got their mirror row written from here.
        let rfcId = null;
        try {
          const meta = await g(tok, `/messages/${sj.id}?format=metadata&metadataHeaders=Message-Id`, true);
          rfcId = (((meta && meta.payload && meta.payload.headers) || [])
            .find(h => /^message-id$/i.test(h.name)) || {}).value || null;
        } catch (e) { /* best effort; the verification pass will fill it in */ }

        await sb('/rest/v1/messages?on_conflict=gmail_message_id&select=id', {
          method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify([{
            tenant_id: q.tenant_id, thread_id: q.thread_id, ticket_id: q.ticket_id,
            gmail_message_id: sj.id, rfc_message_id: rfcId,
            inbox_id: inbox.id, direction: 'outbound',
            from_email: inbox.email_address, from_name: 'Single Key Advisory',
            to_emails: q.to_emails || [], cc_emails: q.cc_emails || [],
            subject: q.subject, snippet: (q.body_text || '').slice(0, 200),
            body_text: q.body_text, body_html: q.body_html,
            sent_at: new Date().toISOString(), has_attachments: !!files?.length,
            classification: 'help'
          }])
        }).catch(() => {});
        out.sent++;
      } catch (e) {
        out.failed++;
        await sb(`/rest/v1/outbound_messages?id=eq.${q.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'failed', error: e.message.slice(0, 400) })
        }).catch(() => {});
      }
    }

    // ---- delivery verification --------------------------------------------
    // status 'sent' has only ever meant "Gmail's API returned 200 and gave us
    // an id". The single thing that could contradict it was a bounce notice
    // arriving through ingestion -- so while ingestion was broken (info@ 5 Sep,
    // support@ 7 Sep) an undelivered mail would have kept a green tick
    // indefinitely and nobody would have known.
    //
    // This asks Gmail directly instead, so the claim no longer depends on the
    // ingestion pipeline being healthy. It also backfills rfc_message_id on
    // mirror rows that never got one, which repairs bounce matching for mail
    // that has already gone out.
    const ver = { checked: 0, in_gmail: 0, bounced: 0, missing: 0, unknown: 0 };
    try {
      const pend = await sb('/rest/v1/outbound_messages?status=eq.sent&delivery_checked_at=is.null'
        + '&gmail_message_id=not.is.null&select=id,from_inbox_id,gmail_message_id,sent_at'
        + '&order=sent_at.desc&limit=12');
      for (const p of (pend || [])) {
        if (left() < 20000) break;
        // Give Gmail a couple of minutes; a thread read straight after sending
        // can miss a failure notice that is still on its way.
        if (Date.now() - new Date(p.sent_at).getTime() < 120000) continue;
        const inbox = inboxById[p.from_inbox_id];
        if (!inbox) continue;
        let state = 'unknown', note = null;
        try {
          const tok = await gmailToken(inbox.email_address);
          const msg = await g(tok, `/messages/${p.gmail_message_id}?format=metadata&metadataHeaders=Message-Id`, true);
          if (!msg) {
            state = 'missing';
            note = 'Gmail accepted this and returned an id, but the message is not in the mailbox.';
          } else {
            state = 'in_gmail';
            const rfc = (((msg.payload && msg.payload.headers) || [])
              .find(h => /^message-id$/i.test(h.name)) || {}).value || null;
            if (rfc) {
              await sb(`/rest/v1/messages?gmail_message_id=eq.${p.gmail_message_id}&direction=eq.outbound&rfc_message_id=is.null`, {
                method: 'PATCH', headers: { prefer: 'return=minimal' },
                body: JSON.stringify({ rfc_message_id: rfc })
              }).catch(() => {});
            }
            // Gmail files a delivery failure into the same thread as the mail
            // that failed. Reading it here needs no ingestion at all.
            const th = msg.threadId
              ? await g(tok, `/threads/${msg.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, true)
              : null;
            const bad = (((th && th.messages) || [])).find(x => {
              const hs = (x.payload && x.payload.headers) || [];
              const from = ((hs.find(h => /^from$/i.test(h.name)) || {}).value) || '';
              const subj = ((hs.find(h => /^subject$/i.test(h.name)) || {}).value) || '';
              if (!/mailer-daemon|postmaster@/i.test(from)) return false;
              if (/\(Delay\)/i.test(subj)) return false;   // still retrying, not a failure
              return /failure|undeliverable|returned mail|delivery status notification/i.test(subj);
            });
            if (bad) {
              state = 'bounced';
              note = 'Gmail reported a delivery failure in this thread.';
            }
          }
        } catch (e) {
          state = 'unknown';
          note = String((e && e.message) || e).slice(0, 200);
        }
        ver.checked++; ver[state] = (ver[state] || 0) + 1;
        await sb(`/rest/v1/outbound_messages?id=eq.${p.id}`, {
          method: 'PATCH', headers: { prefer: 'return=minimal' },
          body: JSON.stringify({ delivery_state: state, delivery_checked_at: new Date().toISOString(), delivery_note: note })
        }).catch(() => {});
      }
    } catch (e) { /* verification must never affect mail */ }

    // ---- retention (portal-level only; Gmail is never touched) ------------
    // Admin-configurable windows with a hard 30-day floor enforced both here
    // and by a database CHECK constraint, so nothing under a month old can
    // ever be deleted, even by an admin.
    const ret = { archived: 0, ignored_deleted: 0, attachments_purged: 0, mails_deleted: 0, activity_purged: 0 };
    try {
      const settings = await sb('/rest/v1/retention_settings?select=*');
      const stDel = async (paths) => fetch(`${SUPA}/storage/v1/object/helpdesk-attachments`, {
        method: 'DELETE',
        headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths })
      }).catch(() => {});

      // a. archive - THREAD-AWARE: a conversation is archived only when its most
      //    recent mail (either direction) is older than the window, so an active
      //    back-and-forth never loses its older mails from view.
      try {
        const n = await sb('/rest/v1/rpc/archive_old_mail', { method: 'POST', body: JSON.stringify({}) });
        ret.archived += (typeof n === 'number' ? n : 0);
      } catch (e) { ret.archive_error = e.message.slice(0, 120); }

      for (const rs of (settings || [])) {
        if (left() < 15000) break;
        const day = 86400000, floor = d => Math.max(d || 0, 30);
        const cut = d => new Date(Date.now() - floor(d) * day).toISOString();
        const attCut = cut(rs.attachment_delete_after_days), delCut = cut(rs.mail_delete_after_days);

        // a2. purge IGNORED mail past its own window (from the moment it was
        //     ignored; a human already reviewed it, so the floor is 1 day)
        const igCut = new Date(Date.now() - Math.max(rs.ignored_delete_after_days || 30, 1) * day).toISOString();
        const igs = await sb(`/rest/v1/messages?tenant_id=eq.${rs.tenant_id}&classification=eq.ignore&classified_at=lt.${encodeURIComponent(igCut)}&select=id&limit=300`);
        if (igs?.length) {
          const igIds = igs.map(x => x.id).join(',');
          const fI = await sb(`/rest/v1/attachments?message_id=in.(${igIds})&storage_path=not.is.null&select=storage_path`);
          if (fI?.length) await stDel(fI.map(a => a.storage_path));
          await sb(`/rest/v1/attachments?message_id=in.(${igIds})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
          await sb(`/rest/v1/messages?id=in.(${igIds})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
          ret.ignored_deleted += igs.length;
        }

        // b. purge attachment FILES past the attachment window (metadata rows stay)
        const atts = await sb(`/rest/v1/attachments?select=id,storage_path,messages!inner(tenant_id,sent_at)&storage_path=not.is.null&messages.tenant_id=eq.${rs.tenant_id}&messages.sent_at=lt.${encodeURIComponent(attCut)}&limit=200`);
        if (atts?.length) {
          await stDel(atts.map(a => a.storage_path));
          await sb(`/rest/v1/attachments?id=in.(${atts.map(a => a.id).join(',')})`, {
            method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ storage_path: null }) });
          ret.attachments_purged += atts.length;
        }

        // c. delete mail past the deletion window - files first, then rows
        const olds = await sb(`/rest/v1/messages?tenant_id=eq.${rs.tenant_id}&sent_at=lt.${encodeURIComponent(delCut)}&select=id&limit=300`);
        if (olds?.length) {
          const ids = olds.map(x => x.id).join(',');
          const f2 = await sb(`/rest/v1/attachments?message_id=in.(${ids})&storage_path=not.is.null&select=storage_path`);
          if (f2?.length) await stDel(f2.map(a => a.storage_path));
          await sb(`/rest/v1/attachments?message_id=in.(${ids})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
          await sb(`/rest/v1/messages?id=in.(${ids})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
          ret.mails_deleted += olds.length;
        }

        // e. purge ACTIVITY LOG entries past their admin-set window (floor 30 days)
        const actCut = cut(rs.activity_retention_days || 365);
        const acts = await sb(`/rest/v1/activity_log?tenant_id=eq.${rs.tenant_id}&created_at=lt.${encodeURIComponent(actCut)}&select=id&limit=1000`);
        if (acts?.length) {
          await sb(`/rest/v1/activity_log?id=in.(${acts.map(x => x.id).join(',')})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
          ret.activity_purged += acts.length;
        }
      }
    } catch (e) { ret.error = e.message.slice(0, 200); }

    const took_s = Math.round((Date.now() - t0) / 1000);
    // Keep the run report. Without it, diagnosing a collection regression means
    // edge logs and guesswork; with it, it is one query. Never let it break a run.
    try {
      await sb('/rest/v1/mail_run_log', { method: 'POST', headers: { prefer: 'return=minimal' },
        body: JSON.stringify([{ took_s, skipped_inbound: skipInbound, mailboxes: report, outbound: out, retention: ret, delivery: ver }]) });
    } catch (e) { /* diagnostics must never affect mail */ }
    res.status(200).json({ ok: true, version: 11, skipped_inbound: skipInbound, took_s, mailboxes: report, outbound: out, delivery: ver, retention: ret });
  } catch (e) {
    res.status(500).json({ error: e.message, fix: e.fix || null });
  }
};
