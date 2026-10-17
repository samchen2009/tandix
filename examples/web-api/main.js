import { TandixClient } from '../../extensions/dsh-browser/dist/web-api/tandix.js';

const el = id => document.getElementById(id);
const storageKey = 'tandix.demo.task.v2';
let client;
let task;
let connection;
let saved;
try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
const messages = {
  'discovery-timeout': '尚未检测到 Tandix。请安装或启用扩展后重新检测。',
  'unavailable': '请在已安装 Tandix 的 Chrome 或 Edge 中打开此页面。',
  'unsupported-page': '请通过网站或本地预览打开此页面。',
  'unsupported-backend': '请在 Tandix 中选择原任务使用的 Codex，再恢复连接。',
  'unsupported-companion': '请更新 Tandix 扩展和本机伴随程序后重试。',
  'disconnected': '连接已断开，原任务仍保留；正在等待重新连接。',
  'unknown-task': '没有找到这个任务，可能尚未提交成功。请确认后再发起新任务。',
  'agent-mismatch': '请恢复原任务使用的 Codex 配置后重新连接。',
};
const report = error => { el('status').textContent = messages[error.code] ?? error.message; };
const persist = () => localStorage.setItem(storageKey, JSON.stringify(saved));
async function ensureConnected() {
  if (connection) return connection;
  connection = (async () => {
    if (client) {
      try { return { client, hello: await client.hello() }; }
      catch { client.close(); client = undefined; }
    }
    client = await TandixClient.discover();
    return { client, hello: await client.hello() };
  })().finally(() => { connection = undefined; });
  return connection;
}
async function observe(handle) {
  task = handle;
  el('run').disabled = true; el('cancel').disabled = false;
  const off = task.onProgress(event => {
    if (event.seq) { saved.cursor = event.seq; persist(); }
    if (event.type === 'delta') el('result').textContent += event.text;
    if (event.type === 'snapshot') el('result').textContent = event.text;
    const interrupted = task.snapshot?.status === 'interrupted';
    el('resume').disabled = !interrupted;
    el('resume-options').hidden = !interrupted;
    if (interrupted) el('status').textContent = `任务已中断，上下文已保留，可继续原任务。${task.snapshot.error?.message || ''}`;
    else if (event.type === 'waiting-for-user') el('status').textContent = '请打开 Tandix 确认本机操作';
    else if (event.type === 'disconnected') el('status').textContent = '连接中断，正在找回同一任务…';
    else el('status').textContent = '正在处理原任务…';
  });
  if (task.snapshot?.text) el('result').textContent = task.snapshot.text;
  try {
    const result = await task.result();
    el('result').textContent = saved.responseFormat === 'json' ? JSON.stringify(result.data, null, 2) : result.text;
    el('status').textContent = '处理完成';
  } catch (error) { report(error); }
  finally {
    off(); task = undefined;
    el('cancel').disabled = true; el('resume').disabled = true; el('resume-options').hidden = true;
    el('run').disabled = false; el('retry').disabled = false;
  }
}
async function detect(requestAccess = false) {
  el('retry').hidden = true; el('status').textContent = '正在连接 Tandix…';
  try {
    const connected = await ensureConnected();
    if (saved?.id) {
      el('status').textContent = '正在找回原任务…';
      if (!connected.hello.authorized && !(requestAccess && await connected.client.authorize())) throw new Error('请点击重新检测并授权，再找回原任务。');
      const handle = await connected.client.attach(saved.id, { afterSeq: saved.cursor || 0 });
      void observe(handle);
    } else { el('status').textContent = '准备就绪'; el('run').disabled = false; }
  } catch (error) {
    report(error); el('retry').hidden = false;
    // An unknown ID means acceptance was not confirmed. Never auto-submit again.
    if (error.code === 'unknown-task') { localStorage.removeItem(storageKey); saved = null; el('run').disabled = false; }
  }
}
el('retry').onclick = () => { void detect(true); };
el('run').onclick = async () => {
  el('run').disabled = true; el('result').textContent = '';
  try {
    const connected = await ensureConnected();
    if (!connected.hello.authorized && !await connected.client.authorize()) throw new Error('未获授权，尚未上传文件。');
    saved = { id: crypto.randomUUID(), cursor: 0, responseFormat: el('json').checked ? 'json' : 'text' };
    persist(); // Save the ID BEFORE acceptance, even if its reply is lost.
    const handle = await connected.client.run({ taskId: saved.id, prompt: el('prompt').value,
      files: [...el('files').files], responseFormat: saved.responseFormat });
    void observe(handle);
  } catch (error) { report(error); el('run').disabled = false; el('retry').hidden = false; }
};
el('resume').onclick = async () => {
  if (!task) return;
  el('resume').disabled = true;
  try {
    saved.resumeRequest ||= crypto.randomUUID(); persist();
    await task.resume({ requestId: saved.resumeRequest,
      prompt: '保留原任务已经完成的工作，只继续剩余部分，不要重新批改已完成的题目。' + el('resume-prompt').value.trim() });
    delete saved.resumeRequest; persist();
  } catch (error) { report(error); el('resume').disabled = false; }
};
el('cancel').onclick = async () => { try { await task?.cancel(); } catch (error) { report(error); } };
window.addEventListener('pagehide', () => client?.close());
void detect();
