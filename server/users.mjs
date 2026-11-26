import { HttpError, ROLE_PERMISSIONS } from './util.mjs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UID = /^[A-Za-z0-9]{1,128}$/;
const validPassword = p => typeof p === 'string' && p.length >= 12 && p.length <= 128;
const fallbackUsername = email => (String(email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '') || 'user');

export function createUsers(db, auth) {
  const col = db.collection('users');
  let adminCache = null;

  const publicUser = (id, d, tokenEmail) => {
    const email = d.email || tokenEmail || '';
    return {
      id, email, username: d.username || fallbackUsername(email), role: d.role,
      permissions: ROLE_PERMISSIONS[d.role] || [], disabled: !!d.disabled, createdAt: d.createdAt || null
    };
  };

  /** Server-side source of truth for the caller's role. The role is never read from the request. */
  async function getProfile(uid, tokenEmail) {
    const snap = await col.doc(uid).get();
    if (!snap.exists) throw new HttpError(403, 'Your account has not been set up for this workspace. Ask an administrator for access.', 'no-profile');
    const d = snap.data();
    if (d.disabled) throw new HttpError(403, 'This account has been disabled. Contact an administrator.', 'account-disabled');
    if (!Object.hasOwn(ROLE_PERMISSIONS, d.role)) throw new HttpError(403, 'Your account has no valid role. Contact an administrator.', 'no-role');
    return publicUser(uid, d, tokenEmail);
  }

  async function hasActiveAdmin() {
    if (adminCache && Date.now() - adminCache.at < 60_000) return adminCache.value;
    const snap = await col.where('role', '==', 'admin').get();
    const value = snap.docs.some(d => !d.data().disabled);
    adminCache = { at: Date.now(), value };
    return value;
  }

  async function list() {
    const snap = await col.get();
    return snap.docs.map(d => publicUser(d.id, d.data())).sort((a, b) => a.username.localeCompare(b.username));
  }

  async function create(actor, b) {
    const email = String(b.email || '').trim().toLowerCase(), username = String(b.username || '').trim(), password = String(b.password ?? ''), role = String(b.role || 'viewer');
    if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, dot, underscore or hyphen.');
    if (!validPassword(password)) throw new HttpError(400, 'Password must contain 12-128 characters.');
    if (!Object.hasOwn(ROLE_PERMISSIONS, role)) throw new HttpError(400, 'Choose a valid role.');
    const clash = rows => {
      if (rows.some(d => (d.data().username || fallbackUsername(d.data().email)).toLowerCase() === username.toLowerCase())) throw new HttpError(409, 'That username already exists.');
      if (rows.some(d => String(d.data().email || '').toLowerCase() === email)) throw new HttpError(409, 'An account with that email address already exists.');
    };
    clash((await col.get()).docs);
    let record;
    try {
      record = await auth.createUser({ email, password, displayName: username, emailVerified: false, disabled: false });
    } catch (e) {
      if (e?.code === 'auth/email-already-exists') throw new HttpError(409, 'An account with that email address already exists.');
      if (e?.code === 'auth/invalid-email') throw new HttpError(400, 'Enter a valid email address.');
      if (e?.code === 'auth/invalid-password' || e?.code === 'auth/weak-password') throw new HttpError(400, 'Password must contain 12-128 characters.');
      throw e;
    }
    const profile = { email, username, role, disabled: false, createdAt: new Date().toISOString(), createdBy: actor.id };
    try {
      await db.runTransaction(async tx => {
        clash((await tx.get(col)).docs);
        tx.create(col.doc(record.uid), profile);
      });
    } catch (e) {
      await auth.deleteUser(record.uid).catch(err => console.error('Rollback of Auth user failed', record.uid, err?.code));
      if (e instanceof HttpError) throw e;
      console.error('Profile creation failed; Auth user rolled back', e);
      throw new HttpError(500, 'The account could not be created. Nothing was saved; try again.');
    }
    adminCache = null;
    return publicUser(record.uid, profile);
  }

  async function update(actor, id, b) {
    if (!UID.test(id)) throw new HttpError(404, 'User not found.');
    if (b.role !== undefined && !Object.hasOwn(ROLE_PERMISSIONS, b.role)) throw new HttpError(400, 'Choose a valid role.');
    if (b.password !== undefined && !validPassword(String(b.password))) throw new HttpError(400, 'Password must contain 12-128 characters.');
    if (b.disabled !== undefined && typeof b.disabled !== 'boolean') throw new HttpError(400, 'Choose a valid account status.');
    const ref = col.doc(id);
    const { before, after } = await db.runTransaction(async tx => {
      const [snap, admins] = await Promise.all([tx.get(ref), tx.get(col.where('role', '==', 'admin'))]);
      if (!snap.exists) throw new HttpError(404, 'User not found.');
      const user = snap.data();
      const nextRole = b.role ?? user.role, nextDisabled = b.disabled === undefined ? !!user.disabled : b.disabled;
      if (actor.id === id && nextRole !== user.role) throw new HttpError(400, 'You cannot change your own role.');
      const otherActiveAdmins = admins.docs.filter(d => d.id !== id && !d.data().disabled).length;
      if ((nextRole !== 'admin' || nextDisabled) && user.role === 'admin' && !user.disabled && otherActiveAdmins === 0) throw new HttpError(400, 'You cannot disable or demote the last active administrator.');
      if (actor.id === id && nextDisabled) throw new HttpError(400, 'You cannot disable your own account.');
      tx.update(ref, { role: nextRole, disabled: nextDisabled });
      return { before: { role: user.role, disabled: !!user.disabled }, after: { role: nextRole, disabled: nextDisabled } };
    });
    const patch = {};
    if (after.disabled !== before.disabled) patch.disabled = after.disabled;
    if (b.password !== undefined) patch.password = String(b.password);
    if (Object.keys(patch).length) {
      try {
        await auth.updateUser(id, patch);
        if (patch.disabled === true || patch.password) await auth.revokeRefreshTokens(id);
      } catch (e) {
        await ref.update(before).catch(err => console.error('Profile revert failed', id, err?.code));
        adminCache = null;
        if (e?.code === 'auth/user-not-found') throw new HttpError(404, 'No Firebase sign-in account exists for this user.');
        console.error('Auth update failed; profile reverted', e);
        throw new HttpError(502, 'The account could not be updated. No changes were saved.');
      }
    }
    adminCache = null;
    return publicUser(id, (await ref.get()).data());
  }

  return { getProfile, hasActiveAdmin, list, create, update };
}
