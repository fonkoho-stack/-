// pages/settings/settings.js
const app = getApp();

function resolveLeadIndex(leadOptions, settings) {
    const fallbackIndex = 2;
    if (!settings || typeof settings !== 'object') {
        return fallbackIndex;
    }

    const rawIndex = Number(settings.leadIndex);
    if (Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < leadOptions.length) {
        return rawIndex;
    }

    const rawMinutes = settings.leadMinutes !== undefined ? settings.leadMinutes : settings.lead_minutes;
    const leadMinutes = Number(rawMinutes);
    if (Number.isFinite(leadMinutes)) {
        const mappedIndex = leadOptions.findIndex((item) => Number(item.value) === leadMinutes);
        if (mappedIndex >= 0) {
            return mappedIndex;
        }
    }

    return fallbackIndex;
}

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
            const leadIndex = resolveLeadIndex(this.data.leadOptions, settings);
            this.setData({
                reminderEnabled: settings.reminderEnabled === undefined ? false : !!settings.reminderEnabled,
                leadIndex,
                semesterStart: settings.semesterStart || '2026-03-02'
            });
        }
        this.syncLatestScheduleFromCloud();
    },

    onShow() {
        this.syncLatestScheduleFromCloud().finally(() => {
            this.fetchSubscriptionCount();
            if (app.globalData.subscriptionCount !== undefined) {
                this.setData({ subscriptionCount: app.globalData.subscriptionCount });
            }
        });
    },

    async syncLatestScheduleFromCloud() {
        try {
            const res = await wx.cloud.callFunction({
                name: 'get_schedule',
                data: { action: 'latest' }
            });
            const schedule = res && res.result && res.result.success ? res.result.data : null;
            if (!schedule) {
                return false;
            }

            const scheduleId = schedule._id || '';
            if (scheduleId) {
                app.globalData.scheduleId = scheduleId;
                wx.setStorageSync('schedule_id', scheduleId);
            }

            if (schedule.reminder_settings && typeof schedule.reminder_settings === 'object') {
                wx.setStorageSync('reminder_settings', schedule.reminder_settings);
                if (schedule.reminder_settings.semesterStart) {
                    wx.setStorageSync('semester_start', schedule.reminder_settings.semesterStart);
                }
                const leadIndex = resolveLeadIndex(this.data.leadOptions, schedule.reminder_settings);
                this.setData({
                    reminderEnabled: schedule.reminder_settings.reminderEnabled === undefined ? false : !!schedule.reminder_settings.reminderEnabled,
                    leadIndex,
                    semesterStart: schedule.reminder_settings.semesterStart || '2026-03-02'
                });
            }
            return true;
        } catch (error) {
            console.error('syncLatestScheduleFromCloud failed', error);
            return false;
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
        const index = parseInt(e.detail.value, 10);
        this.setData({ leadIndex: index });
        this.saveSettings();
    },

    changeSemesterStart(e) {
        this.setData({ semesterStart: e.detail.value });
        this.saveSettings();
    },

    saveSettings() {
        const sid = app.globalData.scheduleId || wx.getStorageSync('schedule_id');
        const safeLeadIndex = Number.isInteger(this.data.leadIndex)
            && this.data.leadIndex >= 0
            && this.data.leadIndex < this.data.leadOptions.length
            ? this.data.leadIndex
            : 2;
        const settings = {
            reminderEnabled: this.data.reminderEnabled,
            leadIndex: safeLeadIndex,
            leadMinutes: this.data.leadOptions[safeLeadIndex].value,
            semesterStart: this.data.semesterStart
        };
        
        // 1. 本地存储
        wx.setStorageSync('reminder_settings', settings);
        wx.setStorageSync('semester_start', settings.semesterStart);
        
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
