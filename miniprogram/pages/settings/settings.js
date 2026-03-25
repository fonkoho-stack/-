// pages/settings/settings.js
const app = getApp();

Page({
    data: {
        reminderEnabled: false,
        leadOptions: [
            { label: '5 分钟', value: 5 },
            { label: '10 分钟', value: 10 },
            { label: '15 分钟', value: 15 },
            { label: '30 分钟', value: 30 },
            { label: '1 小时', value: 60 }
        ],
        leadIndex: 2,
        semesterStart: '2026-03-02',
        subscriptionCount: 0,
        autoSync: true,
        assistSync: false
    },

    onLoad() {
        const settings = wx.getStorageSync('reminder_settings');
        if (settings) {
            this.setData({
                reminderEnabled: settings.reminderEnabled,
                leadIndex: settings.leadIndex || 2,
                semesterStart: settings.semesterStart || '2026-03-02'
            });
        }
    },

    onShow() {
        this.fetchSubscriptionCount();
        if (app.globalData.subscriptionCount !== undefined) {
            this.setData({ subscriptionCount: app.globalData.subscriptionCount });
        }
    },

    fetchSubscriptionCount() {
        const sid = app.globalData.scheduleId || wx.getStorageSync('schedule_id');
        if (!sid) return;
        wx.cloud.callFunction({
            name: 'get_schedule',
            data: { action: 'get_sub_count', schedule_id: sid }
        }).then(res => {
            if (res.result && typeof res.result.data.subscription_count === 'number') {
                const count = res.result.data.subscription_count;
                this.setData({ subscriptionCount: count });
                app.globalData.subscriptionCount = count;
            }
        });
    },

    toggleReminder(e) {
        const enabled = e.detail.value;
        if (enabled) {
            // 联动：开启开关时，自动触发订阅请求以获取额度
            this.requestSubscribe((success) => {
                if (success) {
                    this.setData({ reminderEnabled: true });
                    this.saveSettings();
                } else {
                    // 订阅未成功（用户取消或出错），回滚开关状态
                    this.setData({ reminderEnabled: false });
                    wx.showToast({ title: '开启提醒需授权额度', icon: 'none' });
                }
            });
        } else {
            this.setData({ reminderEnabled: false });
            this.saveSettings();
        }
    },

    requestSubscribe(callback) {
        const sid = app.globalData.scheduleId || wx.getStorageSync('schedule_id');
        if (!sid) {
            wx.showToast({ title: '请先导入课表', icon: 'none' });
            if (typeof callback === 'function') callback(false);
            return;
        }

        const TEMPLATE_ID = 'Z565zxBRTt20vIOi6Zo4S2sIqL2mghnFaRg_MPi-M9c';

        wx.requestSubscribeMessage({
            tmplIds: [TEMPLATE_ID],
            success: (res) => {
                if (res[TEMPLATE_ID] === 'accept') {
                    wx.cloud.callFunction({
                        name: 'get_schedule',
                        data: { action: 'add_sub', schedule_id: sid }
                    }).then(res => {
                        if (res.result && res.result.success) {
                            const newCount = res.result.data.subscription_count;
                            this.setData({ subscriptionCount: newCount });
                            app.globalData.subscriptionCount = newCount;
                            wx.showToast({ title: `额度已增加`, icon: 'success' });
                            if (typeof callback === 'function') callback(true);
                        } else {
                            if (typeof callback === 'function') callback(false);
                        }
                    }).catch(() => {
                        if (typeof callback === 'function') callback(false);
                    });
                } else {
                    if (typeof callback === 'function') callback(false);
                }
            },
            fail: (err) => {
                console.error('订阅请求失败', err);
                if (err.errCode === 20004) {
                    wx.showModal({
                        title: '订阅提示',
                        content: '您关闭了消息接收开关，请在设置中打开以接收提醒',
                        showCancel: false
                    });
                }
                if (typeof callback === 'function') callback(false);
            }
        });
    },

    toggleAutoSync(e) {
        this.setData({ autoSync: e.detail.value });
        wx.showToast({ title: e.detail.value ? '自动同步已开启' : '自动同步已关闭', icon: 'none' });
        // 后续可对接云端定时同步
    },

    toggleAssistSync(e) {
        this.setData({ assistSync: e.detail.value });
    },

    changeLeadTime(e) {
        const index = parseInt(e.detail.value);
        this.setData({ leadIndex: index });
        this.saveSettings();
    },

    changeSemesterStart(e) {
        this.setData({ semesterStart: e.detail.value });
        this.saveSettings();
    },

    saveSettings() {
        const sid = app.globalData.scheduleId || wx.getStorageSync('schedule_id');
        const settings = {
            reminderEnabled: this.data.reminderEnabled,
            leadIndex: this.data.leadIndex,
            leadMinutes: this.data.leadOptions[this.data.leadIndex].value,
            semesterStart: this.data.semesterStart
        };
        
        // 1. 本地存储
        wx.setStorageSync('reminder_settings', settings);
        
        // 2. 云端同步（如果已导入课表）
        if (sid) {
            wx.cloud.callFunction({
                name: 'get_schedule',
                data: { 
                    action: 'update_reminder', 
                    schedule_id: sid,
                    reminder_settings: settings
                }
            }).then(res => {
                if (res.result && res.result.success) {
                    wx.showToast({ title: '云端设置已同步', icon: 'success' });
                } else {
                    wx.showToast({ title: '仅保存到本地', icon: 'none' });
                }
            }).catch(err => {
                console.error('设置同步失败', err);
            });
        } else {
            wx.showToast({ title: '本地设置已保存', icon: 'success' });
        }
    },

    clearData() {
        wx.showModal({
            title: '确认清除',
            content: '将删除本地缓存的所有课表数据',
            success: (res) => {
                if (res.confirm) {
                    wx.clearStorageSync();
                    app.globalData.scheduleData = null;
                    app.globalData.scheduleId = '';
                    wx.showToast({ title: '已清除', icon: 'success' });
                    setTimeout(() => wx.reLaunch({ url: '/pages/upload/upload' }), 1000);
                }
            }
        });
    }
});
