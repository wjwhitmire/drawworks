// ---------------------------------------------------------------- network: one gate, nothing behind it
// Every request this page could make would have to pass through net(). There are no network features
// today, so the list is empty and the gate refuses everything; the headless test confirms the page
// makes zero requests. A future feature would add an entry here, off by default, with its one host.
const NET_FEATURES = {};
function netDecision(feature, url) {
  const f = NET_FEATURES[feature];
  if (!f) return { ok: false, reason: "no such network feature" };
  if (!(APP.kvNet && APP.kvNet[feature] === true)) return { ok: false, reason: f.title + " is off" };
  let u;
  try { u = new URL(url); } catch (e) { return { ok: false, reason: "not a web address" }; }
  if (u.protocol !== "https:" || !f.hosts.includes(u.hostname)) return { ok: false, reason: u.hostname + " is not allowed" };
  return { ok: true };
}
async function net(feature, url, opts) {
  const d = netDecision(feature, url);
  if (!d.ok) throw new Error("Blocked: " + d.reason + ".");
  return fetch(url, Object.assign({ credentials: "omit", referrerPolicy: "no-referrer" }, opts || {}));
}
