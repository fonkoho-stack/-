const app = getApp();
const {
    callAssist,
    chooseAndUploadSignPhoto,
    formatTimeText,
    getAccountCache,
    normalizeError,
    setAlertCache,
    setAccountCache,
} = require('../../../utils/assist');

function buildResultMessage(result) {
    if (!result) {
        return '操作完成';
    }
    return result.message || '操作完成';
}

Page({
    data: {
        loading: true,
        submitting: false,
        courseId: '',
        activeId: '',
        courseName: '',
        activityName: '',
        signType: '',
        detail: null,
        account: null,
        code: '',
        recentPhotoText: '',
        helperText: '',
    },

    onLoad(options) {
        this.setData({
            courseId: options.courseId || '',
            activeId: options.activeId || '',
            courseName: decodeURIComponent(options.courseName || '课程'),
            activityName: decodeURIComponent(options.activityName || '签到'),
            signType: options.signType || '',
            account: getAccountCache(),
        });
        wx.setNavigationBarTitle({
            title: decodeURIComponent(options.activityName || '签到'),
        });
    },

    onShow() {
        this.loadPageData();
    },

    async loadPageData() {
        this.setData({ loading: true });
        try {
            const [detail, account] = await Promise.all([
                callAssist('get_activity_detail', {
                    activeId: this.data.activeId,
                    signType: this.data.signType,
                }),
                callAssist('get_account'),
            ]);
            if (account) {
                setAccountCache(account);
                app.globalData.assistAccount = account;
            }
            this.setData({
                loading: false,
                detail,
                account,
                recentPhotoText: account && account.lastSignPhotoUpdatedAt
                    ? `最近更新：${formatTimeText(account.lastSignPhotoUpdatedAt)}`
                    : '',
                helperText: this.buildHelperText(detail),
            });
        } catch (error) {
            const detail = normalizeError(error, '加载签到详情失败');
            this.setData({ loading: false });
            wx.showToast({ title: detail.message, icon: 'none' });
        }
    },

    async syncAlertSummary() {
        try {
            const summary = await callAssist('get_sign_notifications');
            setAlertCache(summary);
        } catch (error) {
            // Ignore reminder refresh errors inside the sign page.
        }
    },

    buildHelperText(detail) {
        if (!detail) {
            return '';
        }
        if (detail.signed) {
            return '当前账号已经完成过这次签到。';
        }
        if (detail.needCaptcha) {
            return '这次签到要求滑块验证，小程序一期暂不支持。';
        }
        if (detail.unsupportedReason) {
            return detail.unsupportedReason;
        }
        if (detail.signType === 'normal' && detail.needPhoto) {
            return '这是一次拍照签到，请先选择图片，系统会优先使用最近一次保存的签到图。';
        }
        if (detail.signType === 'code') {
            return `请输入 ${detail.numberCount || 0} 位签到码后提交。`;
        }
        if (detail.signType === 'qrcode') {
            return '请扫描老师提供的超星二维码完成签到。';
        }
        return '确认信息无误后即可发起签到。';
    },

    updateCode(e) {
        this.setData({ code: e.detail.value || '' });
    },

    async pickSignPhoto() {
        try {
            const upload = await chooseAndUploadSignPhoto();
            const account = await callAssist('save_sign_photo', {
                cloudFileId: upload.cloudFileId,
                fileName: upload.fileName,
            });
            setAccountCache(account);
            app.globalData.assistAccount = account;
            this.setData({
                account,
                recentPhotoText: account && account.lastSignPhotoUpdatedAt
                    ? `最近更新：${formatTimeText(account.lastSignPhotoUpdatedAt)}`
                    : '',
            });
            wx.showToast({ title: '签到图片已更新', icon: 'success' });
        } catch (error) {
            if (error && error.errMsg && error.errMsg.includes('cancel')) {
                return;
            }
            const detail = normalizeError(error, '更新签到图片失败');
            wx.showToast({ title: detail.message, icon: 'none' });
        }
    },

    async submitNormal() {
        await this.submitAction('sign_normal', {
            courseId: this.data.courseId,
            activeId: this.data.activeId,
        });
    },

    async submitPhoto() {
        if (!this.data.account || !this.data.account.lastSignPhotoFileId) {
            wx.showToast({ title: '请先选择签到图片', icon: 'none' });
            return;
        }
        await this.submitAction('sign_photo', {
            courseId: this.data.courseId,
            activeId: this.data.activeId,
        });
    },

    async submitCode() {
        const signCode = (this.data.code || '').trim();
        if (!signCode) {
            wx.showToast({ title: '请输入签到码', icon: 'none' });
            return;
        }
        await this.submitAction('sign_code', {
            courseId: this.data.courseId,
            activeId: this.data.activeId,
            signCode,
        });
    },

    async scanAndSubmit() {
        try {
            const scan = await new Promise((resolve, reject) => {
                wx.scanCode({
                    onlyFromCamera: false,
                    success: resolve,
                    fail: reject,
                });
            });
            await this.submitAction('sign_qrcode', {
                courseId: this.data.courseId,
                activeId: this.data.activeId,
                expectedActiveId: this.data.activeId,
                scannedContent: scan.result,
            });
        } catch (error) {
            if (error && error.errMsg && error.errMsg.includes('cancel')) {
                return;
            }
            const detail = normalizeError(error, '二维码签到失败');
            wx.showToast({ title: detail.message, icon: 'none' });
        }
    },

    async submitAction(action, payload) {
        this.setData({ submitting: true });
        try {
            const result = await callAssist(action, payload);
            await this.syncAlertSummary();
            const message = buildResultMessage(result);
            wx.showModal({
                title: result && result.status === 'already_signed' ? '已完成签到' : '签到结果',
                content: message,
                showCancel: false,
            });
            this.setData({
                detail: {
                    ...(this.data.detail || {}),
                    signed: true,
                },
                helperText: result && result.status === 'already_signed'
                    ? '当前账号已经完成过这次签到。'
                    : '签到已完成，可以返回活动列表继续处理其它活动。',
            });
        } catch (error) {
            const detail = normalizeError(error, '签到失败');
            wx.showToast({ title: detail.message, icon: 'none' });
        } finally {
            this.setData({ submitting: false });
        }
    },
});
