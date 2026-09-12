// SKA Helpdesk admin endpoint. Lives beside the mail runner because this is
// where the service key lives - the browser never holds it. Every call must
// carry a signed-in user's session token, and that user must be a tenant admin.
const { randomUUID } = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const SUPA = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPA || !KEY) { res.status(500).json({ error: 'Not configured' }); return; }

    const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!bearer) { res.status(401).json({ error: 'unauthorized' }); return; }
    const uR = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: KEY, authorization: `Bearer ${bearer}` } });
    if (!uR.ok) { res.status(401).json({ error: 'unauthorized' }); return; }
    const caller = await uR.json();
    const mR = await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${caller.id}&select=tenant_id,role&limit=1`,
      { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'public' } });
    const mem = (mR.ok ? await mR.json() : [])[0];
    if (!mem || mem.role !== 'admin') { res.status(403).json({ error: 'Only workspace admins can manage users' }); return; }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    const svc = { apikey: KEY, authorization: `Bearer ${KEY}` };
    const svcJson = { ...svc, 'content-type': 'application/json' };

    // Every member-management action lands in the unified activity log.
    const logAct = (action, label, detail) => fetch(`${SUPA}/rest/v1/activity_log`, {
      method: 'POST',
      headers: { ...svcJson, 'content-profile': 'helpdesk', prefer: 'return=minimal' },
      body: JSON.stringify([{ tenant_id: mem.tenant_id, actor_id: caller.id, action, target_kind: 'member', target_label: label || '', detail: detail || {} }])
    }).catch(() => {});
    const nameOf = async (uid) => {
      const r = await fetch(`${SUPA}/rest/v1/profiles?id=eq.${uid}&select=full_name`, { headers: { ...svc, 'accept-profile': 'public' } });
      const j = r.ok ? await r.json() : [];
      return j[0]?.full_name || 'a member';
    };

    if (body.action === 'list_users') {
      const lR = await fetch(`${SUPA}/auth/v1/admin/users?per_page=200`, { headers: svc });
      const lj = await lR.json();
      const users = lj.users || (Array.isArray(lj) ? lj : []);
      const mm = await fetch(`${SUPA}/rest/v1/memberships?tenant_id=eq.${mem.tenant_id}&select=user_id,role`,
        { headers: { ...svc, 'accept-profile': 'public' } });
      const mems = mm.ok ? await mm.json() : [];
      const un = await fetch(`${SUPA}/rest/v1/usernames?select=user_id,username`,
        { headers: { ...svc, 'accept-profile': 'helpdesk' } });
      const unames = Object.fromEntries((un.ok ? await un.json() : []).map(x => [x.user_id, x.username]));
      const roleBy = Object.fromEntries(mems.map(x => [x.user_id, x.role]));
      const out = users.filter(u => roleBy[u.id]).map(u => ({
        id: u.id, email: u.email,
        name: u.user_metadata?.full_name || null,
        username: unames[u.id] || null,
        role: roleBy[u.id],
        last_sign_in_at: u.last_sign_in_at || null,
        must_change: !!u.user_metadata?.must_change_password
      }));
      res.status(200).json({ users: out }); return;
    }

    if (body.action === 'create_user') {
      let { email, username, password, full_name, role } = body;
      username = (username || '').trim().toLowerCase();
      if (!/^[a-z0-9._]{3,20}$/.test(username)) { res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, dots, underscores' }); return; }
      if (!password || password.length < 8) { res.status(400).json({ error: 'Initial password must be at least 8 characters' }); return; }
      const dup = await fetch(`${SUPA}/rest/v1/usernames?username=eq.${encodeURIComponent(username)}&select=user_id&limit=1`,
        { headers: { ...svc, 'accept-profile': 'helpdesk' } });
      if (dup.ok && (await dup.json()).length) { res.status(400).json({ error: `Username "${username}" is taken` }); return; }
      if (email && !email.includes('@')) { res.status(400).json({ error: 'That email does not look valid' }); return; }
      if (!email) email = `${username}@team.skamail.internal`;   // login is by username; no real mailbox needed
      const cR = await fetch(`${SUPA}/auth/v1/admin/users`, {
        method: 'POST', headers: svcJson,
        body: JSON.stringify({
          email, password, email_confirm: true,
          user_metadata: { full_name: full_name || username, must_change_password: true }
        })
      });
      const cj = await cR.json();
      if (!cR.ok) { res.status(400).json({ error: cj.msg || cj.message || JSON.stringify(cj).slice(0, 200) }); return; }
      const uid = cj.id || cj.user?.id;
      const iR = await fetch(`${SUPA}/rest/v1/memberships`, {
        method: 'POST',
        headers: { ...svcJson, 'content-profile': 'public', prefer: 'return=minimal' },
        body: JSON.stringify([{ id: randomUUID(), user_id: uid, tenant_id: mem.tenant_id, role: role === 'admin' ? 'admin' : 'member' }])
      });
      if (!iR.ok) { res.status(400).json({ error: 'User created but adding them to the workspace failed: ' + (await iR.text()).slice(0, 200) }); return; }
      await fetch(`${SUPA}/rest/v1/profiles?id=eq.${uid}`, {
        method: 'PATCH', headers: { ...svcJson, 'content-profile': 'public', prefer: 'return=minimal' },
        body: JSON.stringify({ full_name: full_name || null })
      }).catch(() => {});
      await fetch(`${SUPA}/rest/v1/usernames`, {
        method: 'POST', headers: { ...svcJson, 'content-profile': 'helpdesk', prefer: 'return=minimal' },
        body: JSON.stringify([{ user_id: uid, tenant_id: mem.tenant_id, username }])
      });
      await logAct('member_added', `@${username} (${full_name || username})`, { role: role === 'admin' ? 'admin' : 'member' });
      res.status(200).json({ ok: true, id: uid, username }); return;
    }

    if (body.action === 'update_user') {
      const { user_id, full_name, role } = body;
      if (!user_id) { res.status(400).json({ error: 'user_id is required' }); return; }
      const tR = await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${user_id}&tenant_id=eq.${mem.tenant_id}&select=user_id&limit=1`,
        { headers: { ...svc, 'accept-profile': 'public' } });
      if (!((tR.ok ? await tR.json() : [])[0])) { res.status(404).json({ error: 'That user is not in this workspace' }); return; }
      if (role) {
        if (user_id === caller.id && role !== 'admin') { res.status(400).json({ error: 'You cannot demote yourself' }); return; }
        await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${user_id}&tenant_id=eq.${mem.tenant_id}`, {
          method: 'PATCH', headers: { ...svcJson, 'content-profile': 'public', prefer: 'return=minimal' },
          body: JSON.stringify({ role: role === 'admin' ? 'admin' : 'member' })
        });
        await logAct('member_role_changed', `${await nameOf(user_id)} → ${role === 'admin' ? 'admin' : 'member'}`, { to: role });
      }
      if (full_name !== undefined) {
        await fetch(`${SUPA}/rest/v1/profiles?id=eq.${user_id}`, {
          method: 'PATCH', headers: { ...svcJson, 'content-profile': 'public', prefer: 'return=minimal' },
          body: JSON.stringify({ full_name: full_name || null })
        }).catch(() => {});
        const gR = await fetch(`${SUPA}/auth/v1/admin/users/${user_id}`, { headers: svc });
        const gj = gR.ok ? await gR.json() : {};
        await fetch(`${SUPA}/auth/v1/admin/users/${user_id}`, {
          method: 'PUT', headers: svcJson,
          body: JSON.stringify({ user_metadata: { ...(gj.user_metadata || {}), full_name } })
        }).catch(() => {});
        await logAct('member_renamed', `→ ${full_name || '(cleared)'}`, {});
      }
      res.status(200).json({ ok: true }); return;
    }

    if (body.action === 'remove_user') {
      const { user_id } = body;
      if (!user_id) { res.status(400).json({ error: 'user_id is required' }); return; }
      if (user_id === caller.id) { res.status(400).json({ error: 'You cannot remove yourself' }); return; }
      const tR = await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${user_id}&tenant_id=eq.${mem.tenant_id}&select=user_id&limit=1`,
        { headers: { ...svc, 'accept-profile': 'public' } });
      if (!((tR.ok ? await tR.json() : [])[0])) { res.status(404).json({ error: 'That user is not in this workspace' }); return; }
      await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${user_id}&tenant_id=eq.${mem.tenant_id}`, {
        method: 'DELETE', headers: { ...svc, 'content-profile': 'public', prefer: 'return=minimal' } });
      await fetch(`${SUPA}/rest/v1/usernames?user_id=eq.${user_id}`, {
        method: 'DELETE', headers: { ...svc, 'content-profile': 'helpdesk', prefer: 'return=minimal' } }).catch(() => {});
      const remName = await nameOf(user_id);
      await fetch(`${SUPA}/auth/v1/admin/users/${user_id}`, {
        method: 'PUT', headers: svcJson, body: JSON.stringify({ ban_duration: '876000h' })
      }).catch(() => {});
      await logAct('member_removed', remName, {});
      res.status(200).json({ ok: true }); return;
    }

    if (body.action === 'reset_password') {
      const { user_id, password } = body;
      if (!user_id) { res.status(400).json({ error: 'user_id is required' }); return; }
      if (!password || password.length < 8) { res.status(400).json({ error: 'Temporary password must be at least 8 characters' }); return; }
      // Target must belong to this admin's workspace - no cross-tenant resets.
      const tR = await fetch(`${SUPA}/rest/v1/memberships?user_id=eq.${user_id}&tenant_id=eq.${mem.tenant_id}&select=user_id&limit=1`,
        { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'accept-profile': 'public' } });
      if (!((tR.ok ? await tR.json() : [])[0])) { res.status(404).json({ error: 'That user is not in this workspace' }); return; }
      // Merge metadata ourselves so full_name etc. survive regardless of API merge semantics.
      const gR = await fetch(`${SUPA}/auth/v1/admin/users/${user_id}`,
        { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } });
      const gj = gR.ok ? await gR.json() : {};
      const meta = { ...(gj.user_metadata || {}), must_change_password: true };
      const pR = await fetch(`${SUPA}/auth/v1/admin/users/${user_id}`, {
        method: 'PUT',
        headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ password, user_metadata: meta })
      });
      const pj = await pR.json();
      if (!pR.ok) { res.status(400).json({ error: pj.msg || pj.message || JSON.stringify(pj).slice(0, 200) }); return; }
      await logAct('password_reset', await nameOf(user_id), {});
      res.status(200).json({ ok: true }); return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
