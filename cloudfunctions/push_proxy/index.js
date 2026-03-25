// 云函数：push_proxy
// 用途：代理调用 Pushplus HTTP API 发送推送消息

const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
    const { token, title, content, template, uids } = event;

    const postData = JSON.stringify({
        token,
        title: title || '课程提醒',
        content,
        template: template || 'markdown',
        uids: uids || []
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'www.pushplus.plus',
            port: 443,
            path: '/send',
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
                    console.log('Pushplus API 返回:', result);
                    resolve(result);
                } catch (e) {
                    resolve({ code: -1, msg: 'JSON parse error', raw: data });
                }
            });
        });

        req.on('error', (err) => {
            console.error('Pushplus HTTP error:', err);
            reject(err);
        });

        req.write(postData);
        req.end();
    });
};
