// Shows what the preload exposed and whether the core answers (via the CSP-allowed 127.0.0.1).
const b = window.bizzi;
const conn = b && b.connection;
document.getElementById('bizzi').textContent = JSON.stringify(
  { platform: b && b.platform, versions: b && b.versions, url: conn && conn.url, token: conn && conn.token ? '<present>' : '<missing>' },
  null,
  2,
);
if (conn) {
  const health = new URL(conn.url);
  health.protocol = 'http:';
  health.pathname = '/healthz';
  fetch(health)
    .then((r) => r.text())
    .then((t) => (document.getElementById('health').textContent = `core /healthz: ${t}`))
    .catch((e) => (document.getElementById('health').textContent = `core /healthz failed: ${e}`));
}
