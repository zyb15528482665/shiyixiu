// 试衣秀本地代理 - 解决浏览器 CORS 限制
// 用法: node proxy.js
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const DASHSCOPE = 'dashscope.aliyuncs.com';

// API Key（从环境变量或命令行参数读取）
let API_KEY = process.env.ALIYUN_KEY || '';

// CORS headers
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function jsonReply(res, data, status) {
  res.writeHead(status || 200, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve(body); }
    });
    req.on('error', reject);
  });
}

function dashscopeRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: DASHSCOPE,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(data));

    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// 上传图片到 imgbb（从服务器端，无CORS限制）
function uploadToHost(dataURL) {
  return new Promise((resolve, reject) => {
    const parts = dataURL.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const base64 = parts[1];
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const body = [
      '--' + boundary,
      'Content-Disposition: form-data; name="image"',
      'Content-Type: ' + mime,
      '',
      base64,
      '--' + boundary + '--',
    ].join('\r\n');

    const opts = {
      hostname: 'api.imgbb.com',
      path: '/1/upload?key=7d93c8e3d6e2e4b5a1f0c9d8e7b6a5f4',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.success && j.data && j.data.url) resolve(j.data.url);
          else reject(new Error('Upload failed: ' + data));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 主服务器
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost:' + PORT);

  // GET /status - 健康检查
  if (url.pathname === '/status' && req.method === 'GET') {
    jsonReply(res, { ok: true, hasKey: !!API_KEY });
    return;
  }

  // POST /key - 设置API Key
  if (url.pathname === '/key' && req.method === 'POST') {
    const body = await readBody(req);
    API_KEY = body.key || '';
    jsonReply(res, { ok: true, saved: !!API_KEY });
    return;
  }

  // POST /tryon - 试穿（核心接口）
  if (url.pathname === '/tryon' && req.method === 'POST') {
    if (!API_KEY) {
      jsonReply(res, { error: '请先设置 API Key' }, 400);
      return;
    }

    try {
      const body = await readBody(req);
      const clothImg = body.cloth; // base64 data URL

      // 1. 上传图片到图床（服务器端无CORS限制）
      console.log('📤 上传图片...');
      const clothURL = await uploadToHost(clothImg);
      console.log('   ✅ 图片URL:', clothURL.slice(0, 50) + '...');

      // 2. 调用DashScope虚拟模特API
      console.log('🎨 调用通义万相...');
      const taskResult = await dashscopeRequest('POST',
        '/api/v1/services/aigc/virtualmodel/generation/',
        {
          model: 'wanx-virtualmodel',
          input: {
            base_image_url: clothURL,
            face_image_url: clothURL,
            prompt: '真实风格，高质量服装展示',
            face_prompt: '真实人脸，自然光线'
          },
          parameters: { short_side_size: '1024', n: 1 }
        }
      );

      if (taskResult.status !== 200) {
        console.log('   ❌ API错误:', JSON.stringify(taskResult.data));
        jsonReply(res, { error: 'API调用失败: ' + (taskResult.data.message || '未知错误') }, 500);
        return;
      }

      const taskId = taskResult.data.output.task_id;
      console.log('   📋 任务ID:', taskId);

      // 3. 轮询结果
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const checkResult = await dashscopeRequest('GET',
          '/api/v1/tasks/' + taskId
        );

        if (checkResult.data.output.task_status === 'SUCCEEDED') {
          const resultURL = checkResult.data.output.results[0].url;
          console.log('   ✅ 生成成功!');
          jsonReply(res, { success: true, image_url: resultURL });
          return;
        } else if (checkResult.data.output.task_status === 'FAILED') {
          console.log('   ❌ 生成失败:', checkResult.data.output.message);
          jsonReply(res, { error: '生成失败: ' + checkResult.data.output.message }, 500);
          return;
        }
        console.log('   ⏳ 等待中...(' + ((i+1)*2) + 's)');
      }

      jsonReply(res, { error: '生成超时，请重试' }, 500);
    } catch (e) {
      console.error('❌ 错误:', e.message);
      jsonReply(res, { error: e.message }, 500);
    }
    return;
  }

  // GET / - 返回试衣秀页面
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    try {
      const htmlPath = path.join(__dirname, '..', 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      jsonReply(res, { error: '无法加载页面' }, 500);
    }
    return;
  }

  // GET /manifest.json
  if (url.pathname === '/manifest.json' && req.method === 'GET') {
    try {
      const mp = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(mp);
    } catch(e) { res.writeHead(404); res.end(); }
    return;
  }

  // GET /sw.js
  if (url.pathname === '/sw.js' && req.method === 'GET') {
    try {
      const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/javascript' });
      res.end(sw);
    } catch(e) { res.writeHead(404); res.end(); }
    return;
  }

  // 404
  jsonReply(res, { error: 'Not found' }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('╔══════════════════════════════════╗');
  console.log('║    👗 试衣秀 本地代理服务         ║');
  console.log('║    端口: ' + PORT + '                     ║');
  console.log('║    地址: http://127.0.0.1:' + PORT + '   ║');
  console.log('╚══════════════════════════════════╝');
  console.log('');
  console.log('📋 API接口:');
  console.log('   GET  /status       查看状态');
  console.log('   POST /key          设置API Key  {"key":"sk-xxx"}');
  console.log('   POST /tryon        试穿          {"cloth":"data:image/jpeg;base64,..."}');
  console.log('');
  console.log('等待请求...\n');
});
