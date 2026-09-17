// "Privileged" user identities are never listed on the admin Users page and
// can never be renamed through it: a User with role "admin", or a User whose
// email is also an Admin-collection identity. (An Admin document has its own
// _id and requireAdmin grants by token _id, so a same-email customer row is
// not itself an admin actor — this exclusion is defensive.)
const Admin = require("../models/Admin");

async function privilegedEmails({ session } = {}) {
  const query = Admin.distinct("email");
  if (session) query.session(session);
  const emails = await query;
  return emails.filter(Boolean).map((e) => String(e).toLowerCase());
}

// Match clause for User queries that must exclude privileged identities.
async function privilegedExclusion({ session } = {}) {
  const emails = await privilegedEmails({ session });
  return { role: { $ne: "admin" }, email: { $nin: emails } };
}

async function isPrivilegedUser(user, { session } = {}) {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (!user.email) return false;
  const query = Admin.exists({ email: String(user.email).toLowerCase() });
  if (session) query.session(session);
  return !!(await query);
}

module.exports = { privilegedEmails, privilegedExclusion, isPrivilegedUser };
