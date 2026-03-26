// app.js - 小程序入口（云开发模式）
App({
    globalData: {
        scheduleData: null,
        scheduleId: '',
        currentWeek: 1,
        subscriptionCount: 0,
        assistAccount: null,
        assistAlertCache: null,
        msgBoxState: { x: 300, y: 500, hasNewMsg: false },
        msgBoxWatchers: [],
    },

    notifyMsgBoxStateChange(newState) {
        this.globalData.msgBoxState = { ...this.globalData.msgBoxState, ...newState };
        wx.setStorage({ key: 'msg_box_state', data: this.globalData.msgBoxState });
        this.globalData.msgBoxWatchers.forEach((watcher) => {
            if (typeof watcher === 'function') {
                watcher(this.globalData.msgBoxState);
            }
        });
    },

    onLaunch() {
        if (!wx.cloud) {
            console.error('请使用 2.2.3 或以上的基础库以使用云能力');
        } else {
            wx.cloud.init({
                env: 'cloud1-2gqxkd6t6713a040',
                traceUser: true,
            });
        }

        const data = wx.getStorageSync('schedule_data');
        const sid = wx.getStorageSync('schedule_id');
        const assistAccount = wx.getStorageSync('assist_account_cache');
        const assistAlertCache = wx.getStorageSync('assist_sign_alert_cache');
        const msgState = wx.getStorageSync('msg_box_state');

        if (data) {
            this.globalData.scheduleData = data;
        }
        if (sid) {
            this.globalData.scheduleId = sid;
        }
        if (assistAccount) {
            this.globalData.assistAccount = assistAccount;
        }
        if (msgState) {
            this.globalData.msgBoxState = msgState;
        }
        if (assistAlertCache) {
            this.globalData.assistAlertCache = assistAlertCache;
            this.globalData.msgBoxState = {
                ...this.globalData.msgBoxState,
                hasNewMsg: (assistAlertCache.unreadCount || 0) > 0,
            };
        }
    },
});
