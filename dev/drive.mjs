// Minimal CDP driver: open a page, wait for it to print DONE, dump the log.
const [, , url, timeoutMs = '180000'] = process.argv;

async function targets() {
  const r = await fetch('http://127.0.0.1:9222/json');
  return r.json();
}

const page = await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no page target');
})();

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    console.log('CONSOLE[' + m.params.type + '] ' + text);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('PAGE-EXCEPTION ' + (m.params.exceptionDetails.exception?.description
      || m.params.exceptionDetails.text));
  }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const msgId = ++id;
  waiting.set(msgId, resolve);
  ws.send(JSON.stringify({ id: msgId, method, params }));
});

await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });

const deadline = Date.now() + Number(timeoutMs);
let text = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 700));
  const res = await send('Runtime.evaluate', {
    expression: "document.getElementById('out')?.textContent || ''",
    returnByValue: true,
  });
  text = res.result?.result?.value || '';
  if (text.includes('DONE')) break;
}
console.log('──────── PAGE OUTPUT ────────');
console.log(text || '(empty)');
if (!text.includes('DONE')) console.log('(timed out before DONE)');
ws.close();
process.exit(0);
