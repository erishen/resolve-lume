import http from 'http';
const url = process.argv[2];
const u = new URL(url);
const baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
function call(method, params, sid) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...baseHeaders, ...(sid ? { 'mcp-session-id': sid } : {}) }, timeout: 8000 },
      (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => {
          const ct = r.headers['content-type'] || '';
          let txt = buf;
          if (ct.includes('text/event-stream')) {
            txt = buf.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          }
          if (!txt.trim()) return res({ sid: r.headers['mcp-session-id'] || sid, result: null });
          try { res({ sid: r.headers['mcp-session-id'] || sid, result: JSON.parse(txt).result }); } catch (e) { rej(e); }
        });
      }
    );
    req.on('error', rej);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}
(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
  const sid = init.sid;
  const nb = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const nr = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...baseHeaders, 'mcp-session-id': sid } }, () => {});
  nr.on('error', () => {});
  nr.write(nb);
  nr.end();
  await new Promise((r) => setTimeout(r, 300));
  const tl = await call('tools/list', {}, sid);
  const tools = tl.result && tl.result.tools ? tl.result.tools : [];
  console.log('TOOLS', tools.length);
  console.log(tools.map((t) => t.name).join(', '));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
