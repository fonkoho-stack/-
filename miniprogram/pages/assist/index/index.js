const app = getApp();
const {
    callAssist,
    chooseAndUploadSignPhoto,
    clearAlertCache,
    clearAccountCache,
    formatTimeText,
    getAlertCache,
    normalizeError,
    setAlertCache,
    setAccountCache,
} = require('../../../utils/assist');

function emptySummary() {
    return {
        alerts: [],
        unreadCount: 0,
        readyCount: 0,
        limitedCount: 0,
        scannedAt: '',
    };
}

Page({
    data: {
        loading: true,
        submitting: false,
        sendingCode: false,
        loginMode: 'password',
        account: null,
        username: '',
        password: '',
        smsCode: '',
        countdown: 0,
        recentPhotoText: '',
        recentAlerts: [],
        unreadCount: 0,
        readyCount: 0,
        limitedCount: 0,
        lastScannedText: '',
        alertNoticeText: '',
        autoSignEnabled: false,
        autoSignLog: [],
    },

    onLoad() {
        this.countdownTimer = null;
    },

    onShow() {
        this.refreshDashboard();
    },

    onUnload() {
        this.clearCountdown();
    },

    async onPullDownRefresh() {
        await this.refreshDashboard(false, true);
        wx.stopPullDownRefresh();
    },

    applyAlertSummary(summary, noticeText = '') {
        const normalized = summary || emptySummary();
        const recentAlerts = (normalized.alerts || []).slice(0, 3).map((item) => ({
            ...item,
            timeText: formatTimeText(item.startTime || item.detectedAt),
        }));

        this.setData({
            recentAlerts,
            unreadCount: normalized.unreadCount || 0,
            readyCount: normalized.readyCount || 0,
            limitedCount: normalized.limitedCount || 0,
            lastScannedText: normalized.scannedAt ? formatTimeText(normalized.scannedAt) : '',
            alertNoticeText: noticeText,
        });
    },

    applyAccount(account) {
        this.setData({
            account,
            recentPhotoText: account && account.lastSignPhotoUpdatedAt
                ? `最近更新：${formatTimeText(account.lastSignPhotoUpdatedAt)}`
                : '',
            autoSignEnabled: account ? !!account.autoSignEnabled : false,
            autoSignLog: account && Array.isArray(account.autoSignLog) ? account.autoSignLog : [],
        });
    },

    async refreshDashboard(showLoading = true, forceRefresh = false) {
        if (showLoading) {
            this.setData({ loading: true });
        }

        try {
            const account = await callAssist('get_account');
            if (account) {
                setAccountCache(account);
                app.globalData.assistAccount = account;
            } else {
                clearAccountCache();
                clearAlertCache();
            }
            this.applyAccount(account);

            if (!account) {
                this.applyAlertSummary(emptySummary());
                this.setData({ loading: false });
                return;
            }

            await this.loadSignSummary(forceRefresh, true);
            this.setData({ loading: false });
        } catch (error) {
            const detail = normalizeError(error, '加载课堂助手失败');
            this.setData({ loading: false });
            wx.showToast({
                title: detail.message,
                icon: 'none',
            });
        }
    },

    async loadSignSummary(forceRefresh = false, silent = false) {
        try {
            const actionName = forceRefresh ? 'refresh_sign_notifications' : 'get_sign_notifications';
            const summary = await callAssist(actionName);
            setAlertCache(summary);
            this.applyAlertSummary(summary);
            return summary;
        } catch (error) {
            const detail = normalizeError(error, '刷新签到提醒失败');
            if (detail.code === 'SETUP_REQUIRED') {
                const cached = getAlertCache();
                this.applyAlertSummary(cached, detail.message);
                return cached;
            }
            if (!silent) {
                wx.showToast({
                    title: detail.message,
                    icon: 'none',
                });
            }
            return emptySummary();
        }
    },

    setLoginMode(event) {
        const mode = event.currentTarget.dataset.mode;
        this.setData({
            loginMode: mode,
            password: '',
            smsCode: '',
        });
    },

    updateField(event) {
        const field = event.currentTarget.dataset.field;
        this.setData({ [field]: event.detail.value });
    },

    async sendSmsCode() {
        const phone = (this.data.username || '').replace(/\s+/g, '');
        if (!/^1\d{10}$/.test(phone)) {
            wx.showToast({
                title: '请输入正确的手机号',
                icon: 'none',
            });
            return;
        }

        this.setData({ sendingCode: true, username: phone });
        try {
            await callAssist('send_sms_code', { phone });
            wx.showToast({
                title: '验证码已发送',
                icon: 'success',
            });
            this.startCountdown();
        } catch (error) {
            const detail = normalizeError(error, '验证码发送失败');
            wx.showToast({
                title: detail.message,
                icon: 'none',
            });
        } finally {
            this.setData({ sendingCode: false });
        }
    },

    async submitLogin() {
        const username = (this.data.username || '').replace(/\s+/g, '');
        if (!username) {
            wx.showToast({
                title: '请输入账号或手机号',
                icon: 'none',
            });
            return;
        }
        if (this.data.loginMode === 'password' && !this.data.password) {
            wx.showToast({
                title: '请输入密码',
                icon: 'none',
            });
            return;
        }
        if (this.data.loginMode === 'sms' && !this.data.smsCode) {
            wx.showToast({
                title: '请输入短信验证码',
                icon: 'none',
            });
            return;
        }

        this.setData({ submitting: true });
        try {
            if (this.data.loginMode === 'password') {
                await callAssist('login_password', {
                    username,
                    password: this.data.password,
                });
            } else {
                await callAssist('login_sms', {
                    phone: username,
                    code: this.data.smsCode,
                });
            }

            wx.showToast({
                title: '绑定成功',
                icon: 'success',
            });
            this.setData({
                password: '',
                smsCode: '',
                username,
            });
            await this.refreshDashboard(false);
        } catch (error) {
            const detail = normalizeError(error, '登录失败');
            if (detail.code === 'SECURITY_VERIFICATION_REQUIRED') {
                wx.showModal({
                    title: '需要安全验证',
                    content: '当前账号需要额外验证，请改用短信验证码登录。',
                    showCancel: false,
                });
            } else {
                wx.showToast({
                    title: detail.message,
                    icon: 'none',
                });
            }
        } finally {
            this.setData({ submitting: false });
        }
    },

    async chooseLatestPhoto() {
        try {
            const upload = await chooseAndUploadSignPhoto();
            const account = await callAssist('save_sign_photo', {
                cloudFileId: upload.cloudFileId,
                fileName: upload.fileName,
            });
            setAccountCache(account);
            app.globalData.assistAccount = account;
            this.applyAccount(account);
            wx.showToast({
                title: '签到图已更新',
                icon: 'success',
            });
        } catch (error) {
            if (error && error.errMsg && error.errMsg.includes('cancel')) {
                return;
            }
            const detail = normalizeError(error, '图片上传失败');
            wx.showToast({
                title: detail.message,
                icon: 'none',
            });
        }
    },

    async chooseDefaultLocation() {
        try {
            const location = await new Promise((resolve, reject) => {
                wx.chooseLocation({
                    success: resolve,
                    fail: reject,
                });
            });
            const { latitude, longitude, address, name } = location;
            wx.showLoading({ title: '保存中', mask: true });
            const result = await callAssist('set_default_location', {
                latitude,
                longitude,
                address: name || address || '预设位置',
            });
            wx.hideLoading();
            const account = this.data.account;
            if (account) {
                account.defaultLocation = result.defaultLocation;
                this.setData({ account });
                setAccountCache(account);
                app.globalData.assistAccount = account;
            }
            wx.showToast({
                title: '位置已保存',
                icon: 'success',
            });
        } catch (error) {
            wx.hideLoading();
            if (error && error.errMsg && (error.errMsg.includes('cancel') || error.errMsg.includes('fail auth'))) {
                return; // 用户取消或未授权不报错
            }
            const detail = normalizeError(error, '保存位置失败');
            wx.showToast({
                title: detail.message,
                icon: 'none',
            });
        }
    },

    async toggleAutoSign(event) {
        const enabled = !!event.detail.value;
        this.setData({ autoSignEnabled: enabled });
        try {
            await callAssist('set_auto_sign_config', {
                enabled,
                types: ['normal', 'photo', 'code', 'pattern', 'location'],
            });
            wx.showToast({
                title: enabled ? '自动签到已开启' : '自动签到已关闭',
                icon: 'success',
            });
        } catch (error) {
            this.setData({ autoSignEnabled: !enabled });
            const detail = normalizeError(error, '设置失败');
            wx.showToast({
                title: detail.message,
                icon: 'none',
            });
        }
    },

    openCourses() {
        wx.navigateTo({
            url: '/pages/assist/courses/index',
        });
    },


    async openAlert(event) {
        const item = event.currentTarget.dataset.item;
        if (!item) {
            return;
        }

        if (!item.canOpen) {
            wx.showModal({
                title: '当前暂不支持',
                content: item.helperText || '这类签到目前还不能直接在小程序里完成。',
                showCancel: false,
            });
            return;
        }

        try {
            const summary = await callAssist('mark_sign_notifications_read', {
                activeId: item.activeId,
            });
            setAlertCache(summary);
            this.applyAlertSummary(summary, this.data.alertNoticeText);
        } catch (error) {
            // Ignore read marker errors and continue navigation.
        }

        const query = [
            `courseId=${encodeURIComponent(item.courseId || '')}`,
            `activeId=${encodeURIComponent(item.activeId || '')}`,
            `courseName=${encodeURIComponent(item.courseName || '')}`,
            `activityName=${encodeURIComponent(item.activityName || '')}`,
            `signType=${encodeURIComponent(item.signType || '')}`,
        ].join('&');

        wx.navigateTo({
            url: `/pages/assist/sign/index?${query}`,
        });
    },

    async logout() {
        const confirm = await new Promise((resolve) => {
            wx.showModal({
                title: '退出超星账号',
                content: '退出后会清理当前绑定账号、签到提醒缓存和最近一张签到图。',
                success: (res) => resolve(!!res.confirm),
            });
        });

        if (!confirm) {
            return;
        }

        this.setData({ submitting: true });
        try {
            await callAssist('logout');
            clearAccountCache();
            clearAlertCache();
            this.applyAccount(null);
            this.applyAlertSummary(emptySummary());
            wx.showToast({
                title: '已退出绑定',
                icon: 'success',
            });
        } catch (error) {
            const detail = normalizeError(error, '退出失败');
            wx.showToast({
                title: detail.message,
                icon: 'none',
            });
        } finally {
            this.setData({ submitting: false });
        }
    },

    startCountdown() {
        this.clearCountdown();
        this.setData({ countdown: 60 });
        this.countdownTimer = setInterval(() => {
            const nextValue = this.data.countdown - 1;
            if (nextValue <= 0) {
                this.clearCountdown();
                this.setData({ countdown: 0 });
                return;
            }
            this.setData({ countdown: nextValue });
        }, 1000);
    },

    clearCountdown() {
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
    },
});
