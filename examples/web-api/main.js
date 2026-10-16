import { TandixClient } from '../../extensions/dsh-browser/dist/web-api/tandix.js';

const el = id => document.getElementById(id);
let client;
let task;
let connection;
const messages = {
  'discovery-timeout': '尚未检测到 Tandix。请安装或启用扩展，刷新网页后重试。',
  'unavailable': '请在已安装 Tandix 的 Chrome 或 Edge 中打开此页面。',
  'unsupported-page': '请通过网站或本地预览打开此页面。',
  'unsupported-backend': '请在 Tandix 中选择并登录 Codex 后重试。',
  'unsupported-companion': '请更新 Tandix 本机伴随程序后重试。',
  'disconnected': '与 Tandix 的连接已断开，可重新提交任务。',
};
const report = error => { el('status').textContent = messages[error.code] ?? error.message; };
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
async function detect() {
  el('retry').hidden = true; el('status').textContent = '正在连接 Tandix…';
  try {
    await ensureConnected();
    el('status').textContent = '准备就绪';
  } catch (error) { report(error); el('retry').hidden = false; }
  finally { el('run').disabled = false; }
}
el('retry').onclick = () => { void detect(); };
el('run').onclick = async () => {
  const options = { prompt: el('prompt').value, files: [...el('files').files], responseFormat: el('json').checked ? 'json' : 'text' };
  el('run').disabled = true; el('retry').disabled = true; el('result').textContent = '';
  try {
    el('status').textContent = '正在连接 Tandix…';
    const connected = await ensureConnected();
    if (!connected.hello.authorized) {
      el('status').textContent = '请在 Tandix 授权页确认首次访问…';
      if (!await connected.client.authorize()) throw new Error('未获授权，尚未上传文件。');
    }
    el('retry').hidden = true; el('status').textContent = '正在上传并处理…';
    task = await connected.client.run(options);
    el('cancel').disabled = false;
    task.onProgress(event => {
      if (event.type === 'delta') el('result').textContent += event.text;
      if (event.type === 'waiting-for-user') el('status').textContent = '请打开 Tandix 确认本机操作';
    });
    const result = await task.result();
    el('result').textContent = options.responseFormat === 'json' ? JSON.stringify(result.data, null, 2) : result.text;
    el('status').textContent = '处理完成';
  } catch (error) { report(error); }
  finally { task = undefined; el('cancel').disabled = true; el('run').disabled = false; el('retry').disabled = false; }
};
el('cancel').onclick = async () => { try { await task?.cancel(); } catch (error) { report(error); } };
window.addEventListener('pagehide', () => client?.close());
void detect();
