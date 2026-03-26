const ACCOUNT_CACHE_KEY = 'assist_account_cache';
const ALERT_CACHE_KEY = 'assist_sign_alert_cache';

function unwrapCloudResult(result) {
    const payload = result && result.result ? result.result : result;
    if (!payload || payload.success !== true) {
        const error = (payload && payload.error) || {};
        const err = new Error(error.message || '操作失败');
        err.code = error.code || 'UNKNOWN_ERROR';
        err.payload = payload;
        throw err;
    }
    return payload.data;
}

function callAssist(action, data = {}) {
    return wx.cloud.callFunction({
        name: 'assist_chaoxing',
        data: {
            action,
            ...data,
        },
    }).then(unwrapCloudResult);
}

function setAccountCache(account) {
    wx.setStorageSync(ACCOUNT_CACHE_KEY, account || null);
    getApp().globalData.assistAccount = account || null;
}

function getAccountCache() {
    return wx.getStorageSync(ACCOUNT_CACHE_KEY) || null;
}

function clearAccountCache() {
    wx.removeStorageSync(ACCOUNT_CACHE_KEY);
    getApp().globalData.assistAccount = null;
}

function setAlertCache(payload) {
    const data = payload || {
        alerts: [],
        unreadCount: 0,
        readyCount: 0,
        limitedCount: 0,
        scannedAt: '',
    };
    wx.setStorageSync(ALERT_CACHE_KEY, data);
    getApp().globalData.assistAlertCache = data;
    if (typeof getApp().notifyMsgBoxStateChange === 'function') {
        getApp().notifyMsgBoxStateChange({
            hasNewMsg: (data.unreadCount || 0) > 0,
        });
    }
}

function getAlertCache() {
    return wx.getStorageSync(ALERT_CACHE_KEY) || {
        alerts: [],
        unreadCount: 0,
        readyCount: 0,
        limitedCount: 0,
        scannedAt: '',
    };
}

function clearAlertCache() {
    wx.removeStorageSync(ALERT_CACHE_KEY);
    getApp().globalData.assistAlertCache = null;
    if (typeof getApp().notifyMsgBoxStateChange === 'function') {
        getApp().notifyMsgBoxStateChange({ hasNewMsg: false });
    }
}

function chooseAndUploadSignPhoto() {
    return new Promise((resolve, reject) => {
        wx.chooseImage({
            count: 1,
            sizeType: ['compressed'],
            sourceType: ['album'],
            success: (res) => {
                const localPath = res.tempFilePaths && res.tempFilePaths[0];
                if (!localPath) {
                    reject(new Error('未选择图片'));
                    return;
                }
                const fileName = localPath.split(/[\\/]/).pop() || `sign-${Date.now()}.jpg`;
                const ext = (fileName.split('.').pop() || 'jpg').toLowerCase();
                const cloudPath = `assist-sign-photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
                wx.cloud.uploadFile({
                    cloudPath,
                    filePath: localPath,
                    success: (uploadRes) => {
                        resolve({
                            localPath,
                            fileName,
                            cloudFileId: uploadRes.fileID,
                        });
                    },
                    fail: reject,
                });
            },
            fail: reject,
        });
    });
}

function formatTimeText(value) {
    if (!value) {
        return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeError(error, fallback = '操作失败') {
    return {
        code: error && error.code ? error.code : 'UNKNOWN_ERROR',
        message: error && error.message ? error.message : fallback,
    };
}

module.exports = {
    callAssist,
    clearAlertCache,
    clearAccountCache,
    chooseAndUploadSignPhoto,
    formatTimeText,
    getAlertCache,
    getAccountCache,
    normalizeError,
    setAlertCache,
    setAccountCache,
};
