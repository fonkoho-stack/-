// pages/webview/login/login.js
const app = getApp();

Page({
    data: {
        loginUrl: 'https://cas.university.edu.cn/login' // 示例地址，需根据实际情况替换
    },

    onLoad(options) {
        if (options.url) {
            this.setData({ loginUrl: decodeURIComponent(options.url) });
        }
    },

    onShareAppMessage() {
        return {
            title: '校园认证登录',
            path: '/pages/webview/login/login'
        };
    }
});
