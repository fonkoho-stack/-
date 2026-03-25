// 云函数：wxpusher_proxy
// 用途：代理调用 WxPusher HTTP API 发送推送消息
// 原因：微信云函数内不能直接使用 fetch，需要通过 got/request 或 Node.js 原生 https 模块

const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
    const { appToken, content, summary, contentType, uids, topicIds, url } = event;

    const postData = JSON.stringify({
        appToken,
        content,
        summary: summary || '',
        contentType: contentType || 1,
        uids: uids || [],
        topicIds: topicIds || [],
        url: url || ''
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'wxpusher.zjiecode.com',
            port: 443,
            path: '/api/send/message',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    console.log('WxPusher API 返回:', result);
                    resolve(result);
                } catch (e) {
                    resolve({ code: -1, msg: 'JSON parse error', raw: data });
                }
            });
        });

        req.on('error', (err) => {
            console.error('WxPusher HTTP error:', err);
            reject(err);
        });

        req.write(postData);
        req.end();
    });
};
