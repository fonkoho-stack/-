const app = getApp();
const {
    callAssist,
    formatTimeText,
    getAlertCache,
    normalizeError,
    setAlertCache,
} = require('../../utils/assist');

const PERIOD_MAP = {
    1: { start: '08:00', end: '08:45' },
    2: { start: '08:55', end: '09:40' },
    3: { start: '10:00', end: '10:45' },
    4: { start: '10:55', end: '11:40' },
    5: { start: '14:30', end: '15:15' },
    6: { start: '15:25', end: '16:10' },
    7: { start: '16:30', end: '17:15' },
    8: { start: '17:25', end: '18:10' },
    9: { start: '19:30', end: '20:15' },
    10: { start: '20:25', end: '21:10' },
    11: { start: '21:20', end: '22:05' },
    12: { start: '22:15', end: '23:00' },
};

function isEventInWeek(event, week) {
    if (!event.weeks) {
        return true;
    }
    if (event.weeks.mode === 'range' && event.weeks.ranges) {
        for (const range of event.weeks.ranges) {
            if (week < range.start || week > range.end) {
                continue;
            }
            if (range.odd_even === 'odd' && week % 2 === 0) {
                continue;
            }
            if (range.odd_even === 'even' && week % 2 !== 0) {
                continue;
            }
            return true;
        }
    } else if (event.weeks.mode === 'list' && event.weeks.list) {
        return event.weeks.list.includes(week);
    }
    return false;
}

function emptySummary() {
    return {
        alerts: [],
        historyAlerts: [],
        unreadCount: 0,
        readyCount: 0,
        limitedCount: 0,
        scannedAt: '',
    };
}

function formatAlertTime(value) {
    return value ? formatTimeText(value) : '';
}

function resolveLeadMinutes(settings, fallback = 15) {
    if (!settings || typeof settings !== 'object') {
        return fallback;
    }
    const raw = settings.leadMinutes !== undefined ? settings.leadMinutes : settings.lead_minutes;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(5, Math.min(60, Math.floor(numeric)));
}

function resolveLeadIndex(leadOptions, settings, fallback = 2) {
    if (!settings || typeof settings !== 'object') {
        return fallback;
    }
    const rawIndex = Number(settings.leadIndex);
    if (Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < leadOptions.length) {
        return rawIndex;
    }
    const leadMinutes = resolveLeadMinutes(settings, NaN);
    if (Number.isFinite(leadMinutes)) {
        const mappedIndex = leadOptions.findIndex((item) => Number(item.value) === leadMinutes);
        if (mappedIndex >= 0) {
            return mappedIndex;
        }
    }
    return fallback;
}

function buildAlertStatusText(alert) {
    const status = String(alert && alert.status || '');
    if (status === 'signed') {
        return '已签到';
    }
    if (status === 'closed') {
        return '已结束';
    }
    if (status === 'limited') {
        return '受限';
    }
    return '待处理';
}

function buildAlertStatusClass(alert) {
    const status = String(alert && alert.status || '');
    if (status === 'signed') {
        return 'is-signed';
    }
    if (status === 'closed') {
        return 'is-closed';
    }
    if (status === 'limited') {
        return 'is-limited';
    }
    return 'is-ready';
}

function toNotificationItem(item, historical = false) {
    const statusText = buildAlertStatusText(item);
    const detailText = item.activityName || item.helperText || statusText;
    const canHandle = !historical && !!item.isActive && item.canOpen !== false;
    return {
        ...item,
        id: item.id || `${item.activeId || 'alert'}_${historical ? 'history' : 'active'}`,
        isSign: true,
        isHistorical: historical,
        canHandle,
        icon: historical ? '记录' : '签到',
        title: item.courseName || (historical ? '签到记录' : '新的签到'),
        desc: historical ? `${statusText} | ${detailText}` : detailText,
        timeText: formatAlertTime(item.startTime || item.detectedAt),
        statusText,
        statusClass: buildAlertStatusClass(item),
        actionText: canHandle ? '处理 >' : '',
    };
}

function buildNotificationBuckets(summary, activeLimit = 4, historyLimit = 8) {
    const normalized = summary || emptySummary();
    const activeAlerts = (normalized.alerts || []).map((item) => toNotificationItem(item, false));
    const seenIds = {};
    activeAlerts.forEach((item) => {
        const key = String(item.id || item.activeId || '');
        if (key) {
            seenIds[key] = true;
        }
    });
    const historyAlerts = (normalized.historyAlerts || [])
        .filter((item) => {
            const key = String(item.id || item.activeId || '');
            if (!key) {
                return true;
            }
            return !seenIds[key];
        })
        .map((item) => toNotificationItem(item, true));
    const active = activeAlerts.slice(0, Math.max(0, activeLimit));
    const history = historyAlerts.slice(0, Math.max(0, historyLimit));
    return {
        active,
        history,
        all: [...active, ...history],
    };
}

Component({
    properties: {
        customNav: {
            type: Boolean,
            value: false,
        },
    },

    data: {
        showMsgBox: false,
        btnX: 300,
        btnY: 500,
        clickX: 0,
        clickY: 0,
        msgBoxAnimateClass: '',
        hasNewMsg: false,
        isSyncing: true,
        isDragging: false,
        useAnimation: false,
        hasSchedule: false,
        isTodayFree: false,
        nextCourse: null,
        tips: [],
        currentTipIndex: 0,
        currentTip: null,
        assistUnreadCount: 0,
        assistLastUpdated: '',
        notifications: [],
        activeNotifications: [],
        historyNotifications: [],
        scrollTarget: '', // 用于自动定位的节点 ID
        isAnimating: false,
        // --- 设置中心数据 ---
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
        currentWeek: 1,
        subscriptionCount: 0,
    },

    lifetimes: {
        attached() {
            const windowInfo = wx.getWindowInfo();
            this._windowWidth = windowInfo.windowWidth;
            this.restoreFloatState();
            
            // 批处理合并初始化数据，避免触发渲染层 Expected updated data 报错
            const initState = {
                ...this.getInitialSyncState(),
                // 确保移动视图位置同步
                btnX: this._lastX,
                btnY: this._lastY
            };
            
            setTimeout(() => {
                this.setData(initState, () => {
                   this.setData({ isSyncing: false, useAnimation: true });
                });
                
                // 启动异步任务
                this.refreshAssistAlerts(true);
                this.fetchSubscriptionCount();
                this.syncLatestScheduleFromCloud().finally(() => {
                    this.applyScheduleStateFromStorage();
                    this.fetchSubscriptionCount();
                });
            }, 50);

            this._stateWatcher = (nextState) => {
                if (this._isSelfMoving) {
                    return;
                }
                this.setData({
                    isSyncing: true,
                    useAnimation: false,
                    btnX: nextState.x,
                    btnY: nextState.y,
                    hasNewMsg: nextState.hasNewMsg,
                }, () => {
                    setTimeout(() => {
                        this.setData({
                            isSyncing: false,
                            useAnimation: true,
                        });
                    }, 80);
                });
                this._lastX = nextState.x;
                this._lastY = nextState.y;
            };

            if (!app.globalData.msgBoxWatchers) {
                app.globalData.msgBoxWatchers = [];
            }
            app.globalData.msgBoxWatchers.push(this._stateWatcher);

            this.refreshTimer = setInterval(() => {
                this.updateDateAndCourse();
            }, 60000);

            this.rotateTimer = setInterval(() => {
                this.rotateTip();
            }, 5000);

            this.alertTimer = setInterval(() => {
                this.refreshAssistAlerts(true);
            }, 45000);
        },

        detached() {
            if (this.refreshTimer) {
                clearInterval(this.refreshTimer);
            }
            if (this.rotateTimer) {
                clearInterval(this.rotateTimer);
            }
            if (this.alertTimer) {
                clearInterval(this.alertTimer);
            }
            if (app.globalData.msgBoxWatchers) {
                const index = app.globalData.msgBoxWatchers.indexOf(this._stateWatcher);
                if (index > -1) {
                    app.globalData.msgBoxWatchers.splice(index, 1);
                }
            }
        },
    },

    pageLifetimes: {
        show() {
            this.restoreFloatState();
            this.syncLatestScheduleFromCloud().finally(() => {
                this.applyScheduleStateFromStorage();
            });
            this.loadAssistAlertsFromCache();
            this.refreshAssistAlerts(true);
            
            // 监听全局引导标志位
            if (app.globalData.triggerRemindGuide) {
                app.globalData.triggerRemindGuide = false;
                this.runAutoGuide();
            }
        },

        hide() {
            if (this.data.showMsgBox) {
                this.closeOverlayImmediately();
            }
        },
    },

    methods: {
        async syncLatestScheduleFromCloud() {
            try {
                const res = await wx.cloud.callFunction({
                    name: 'get_schedule',
                    data: { action: 'latest' }
                });
                const schedule = res && res.result && res.result.success ? res.result.data : null;
                if (!schedule || !Array.isArray(schedule.events)) {
                    return false;
                }

                const scheduleId = schedule._id || '';
                app.globalData.scheduleData = schedule.events;
                app.globalData.scheduleId = scheduleId;
                wx.setStorageSync('schedule_data', schedule.events);
                if (scheduleId) {
                    wx.setStorageSync('schedule_id', scheduleId);
                }

                if (schedule.reminder_settings && typeof schedule.reminder_settings === 'object') {
                    wx.setStorageSync('reminder_settings', schedule.reminder_settings);
                    if (schedule.reminder_settings.semesterStart) {
                        wx.setStorageSync('semester_start', schedule.reminder_settings.semesterStart);
                    }
                }
                return true;
            } catch (error) {
                console.warn('msg-box syncLatestScheduleFromCloud failed:', error);
                return false;
            }
        },

        applyScheduleStateFromStorage() {
            const settings = wx.getStorageSync('reminder_settings');
            const semesterStart = (settings && settings.semesterStart)
                || wx.getStorageSync('semester_start')
                || this.data.semesterStart
                || '2026-03-02';
            const nextState = {
                semesterStart,
            };

            if (settings && typeof settings === 'object') {
                nextState.reminderEnabled = settings.reminderEnabled === undefined ? false : !!settings.reminderEnabled;
                nextState.leadIndex = resolveLeadIndex(this.data.leadOptions, settings);
            }

            const semesterStartDate = new Date(`${semesterStart}T00:00:00`);
            const now = new Date();
            const diffDays = Math.floor((now.getTime() - semesterStartDate.getTime()) / (24 * 3600 * 1000));
            const currentWeek = Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));
            const nextCourseData = this.calculateNextCourse(currentWeek);
            nextState.currentWeek = currentWeek;
            nextState.nextCourse = nextCourseData.nextCourse;
            nextState.hasSchedule = nextCourseData.hasSchedule;
            nextState.isTodayFree = nextCourseData.isTodayFree;
            this.setData(nextState);
        },

        // 提取所有初始同步数据，用于 attached 批处理
        getInitialSyncState() {
            const state = {};
            
            // 1. 设置
            const settings = wx.getStorageSync('reminder_settings');
            if (settings) {
                state.reminderEnabled = settings.reminderEnabled === undefined ? false : !!settings.reminderEnabled;
                state.leadIndex = resolveLeadIndex(this.data.leadOptions, settings);
                state.semesterStart = settings.semesterStart || '2026-03-02';
            }
            
            // 2. 课表与周次
            const startStr = state.semesterStart || this.data.semesterStart;
            const semesterStart = new Date(`${startStr}T00:00:00`);
            const now = new Date();
            const diffDays = Math.floor((now.getTime() - semesterStart.getTime()) / (24 * 3600 * 1000));
            state.currentWeek = Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));
            
            const nextCourseData = this.calculateNextCourse(state.currentWeek);
            state.nextCourse = nextCourseData.nextCourse;
            state.hasSchedule = nextCourseData.hasSchedule;
            state.isTodayFree = nextCourseData.isTodayFree;
            
            // 3. 提示词
            const tipData = this.generateTips();
            state.tips = tipData.tips;
            state.currentTipIndex = 0;
            state.currentTip = tipData.tips[0];
            
            // 4. 签到缓存
            const summary = getAlertCache() || emptySummary();
            const buckets = buildNotificationBuckets(summary);
            state.notifications = buckets.all;
            state.activeNotifications = buckets.active;
            state.historyNotifications = buckets.history;
            state.assistUnreadCount = summary.unreadCount || 0;
            state.assistLastUpdated = summary.scannedAt ? formatAlertTime(summary.scannedAt) : '';
            state.hasNewMsg = (summary.unreadCount || 0) > 0;
            
            return state;
        },

        restoreFloatState() {
            const state = app.globalData.msgBoxState || wx.getStorageSync('msg_box_state') || {
                x: 300,
                y: 500,
                hasNewMsg: false,
            };
            app.globalData.msgBoxState = state;
            this._lastX = Number(state.x) || 300;
            this._lastY = Number(state.y) || 500;
            // 注意：这里不直接 setData，由 attached 统一处理 initState
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
                this.requestSubscribe((success) => {
                    if (success) {
                        this.setData({ reminderEnabled: true });
                        this.saveSettings();
                    } else {
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

        runAutoGuide() {
            // 复用 toggleMsgBox 的波纹展开动画
            this.setData({
                clickX: this._lastX + 40,
                clickY: this._lastY + 28,
                showMsgBox: true,
                msgBoxAnimateClass: 'animate-ripple',
                hasNewMsg: false,
                isAnimating: true,
                scrollTarget: 'settings-section'
            });
            // 等动画播完再弹确认框
            setTimeout(() => {
                this.setData({ isAnimating: false });
                wx.showModal({
                    title: '开启课前提醒',
                    content: '课表导入成功！现在为您开启"课前提醒"功能，请在随后的提示中选择"允许"。',
                    confirmText: '去开启',
                    showCancel: false,
                    success: (res) => {
                        if (res.confirm) {
                            this.requestSubscribe((success) => {
                                if (success) {
                                    this.setData({ reminderEnabled: true });
                                    this.saveSettings();
                                }
                            });
                        }
                    }
                });
            }, 300);
        },

        saveSettings() {
            const safeLeadIndex = Number.isInteger(this.data.leadIndex)
                && this.data.leadIndex >= 0
                && this.data.leadIndex < this.data.leadOptions.length
                ? this.data.leadIndex
                : 2;
            const settings = {
                reminderEnabled: this.data.reminderEnabled,
                leadIndex: safeLeadIndex,
                leadMinutes: this.data.leadOptions[safeLeadIndex].value,
                semesterStart: this.data.semesterStart,
            };
            wx.setStorageSync('reminder_settings', settings);
            wx.setStorageSync('semester_start', settings.semesterStart);

            const sid = app.globalData.scheduleId || wx.getStorageSync('schedule_id');
            if (!sid) {
                return;
            }
            wx.cloud.callFunction({
                name: 'get_schedule',
                data: {
                    action: 'update_reminder',
                    schedule_id: sid,
                    reminder_settings: settings,
                },
            }).catch((err) => {
                console.error('msg-box 同步提醒设置失败', err);
            });
        },

        changeSemesterStart(e) {
            const val = e.detail.value;
            this.setData({ semesterStart: val });
            this.saveSettings();
            // 重算周次和课程
            this.updateDateAndCourse();
        },

        changeLeadTime(e) {
            const index = parseInt(e.detail.value, 10);
            this.setData({ leadIndex: index });
            this.saveSettings();
        },

        calculateNextCourse(currentWeek) {
            const allEvents = app.globalData.scheduleData || wx.getStorageSync('schedule_data');
            if (!allEvents || allEvents.length === 0) {
                return { nextCourse: null, hasSchedule: false, isTodayFree: false };
            }

            const now = new Date();
            const currentDay = now.getDay() === 0 ? 7 : now.getDay();
            const currentTotalMinutes = now.getHours() * 60 + now.getMinutes();
            const settings = wx.getStorageSync('reminder_settings') || { leadMinutes: 15 };
            const leadMinutes = resolveLeadMinutes(settings, 15);

            let nextCourse = null;
            let minDiff = Infinity;
            const todayEvents = allEvents.filter((item) =>
                item.day_of_week === currentDay && isEventInWeek(item, currentWeek)
            );

            if (todayEvents.length === 0) {
                return { nextCourse: null, hasSchedule: true, isTodayFree: true };
            }

            for (const event of todayEvents) {
                const startTime = PERIOD_MAP[event.time.period_start];
                if (!startTime) continue;
                const [hour, minute] = startTime.start.split(':').map(Number);
                const eventMinutes = hour * 60 + minute;
                const diffMinutes = eventMinutes - currentTotalMinutes;
                if (diffMinutes <= 0 || diffMinutes >= minDiff) continue;
                minDiff = diffMinutes;
                nextCourse = {
                    ...event,
                    startTime: startTime.start,
                    location: event.location && event.location.building
                        ? `${event.location.building}${event.location.room || ''}`
                        : ((event.location && event.location.raw) || '未知地点'),
                    countdown: diffMinutes > 60
                        ? `约 ${Math.floor(diffMinutes / 60)} 小时后`
                        : `${diffMinutes} 分钟后`,
                    isUpcoming: diffMinutes <= leadMinutes,
                };
            }
            return { nextCourse, hasSchedule: true, isTodayFree: false };
        },

        generateTips() {
            const tips = [
                {
                    id: 'tip-1',
                    title: '签到提醒会自动进入消息盒子',
                    content: '云端巡检到新的超星签到后，会优先把提醒放到这里，方便你从任意页面快速进入。',
                    footerLeft: '自动刷新',
                    footerRight: '签到提醒',
                },
                {
                    id: 'tip-2',
                    title: '拍照签到支持最近图片复用',
                    content: '你可以先在课堂助手里设置一张最近的签到图，遇到拍照签到时就不用重复上传。',
                    footerLeft: '建议提前准备',
                    footerRight: '拍照签到',
                },
            ];
            return { tips };
        },

        updateDateAndCourse() {
            const startStr = this.data.semesterStart || wx.getStorageSync('semester_start') || '2026-03-02';
            const semesterStart = new Date(`${startStr}T00:00:00`);
            const now = new Date();
            const diffDays = Math.floor((now.getTime() - semesterStart.getTime()) / (24 * 3600 * 1000));
            const currentWeek = Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));
            
            const nextData = this.calculateNextCourse(currentWeek);
            this.setData({ 
                currentWeek,
                ...nextData
            });
        },

        loadAssistAlertsFromCache() {
            const summary = getAlertCache() || emptySummary();
            this.applyAssistSummary(summary);
        },


        applyAssistSummary(summary) {
            const normalized = summary || emptySummary();
            const buckets = buildNotificationBuckets(normalized);
            const unreadCount = normalized.unreadCount || 0;
            const assistLastUpdated = normalized.scannedAt ? formatAlertTime(normalized.scannedAt) : '';
            this.setData({
                notifications: buckets.all,
                activeNotifications: buckets.active,
                historyNotifications: buckets.history,
                assistUnreadCount: unreadCount,
                assistLastUpdated,
                hasNewMsg: unreadCount > 0,
            });
            if (typeof app.notifyMsgBoxStateChange === 'function') {
                app.notifyMsgBoxStateChange({ hasNewMsg: unreadCount > 0 });
            }
        },

        async refreshAssistAlerts(silent = false) {
            try {
                const summary = await callAssist('get_sign_notifications');
                setAlertCache(summary);
                this.applyAssistSummary(summary);
            } catch (error) {
                const detail = normalizeError(error, '加载签到提醒失败');
                if (detail.code === 'AUTH_REQUIRED' || detail.code === 'SETUP_REQUIRED') {
                    const summary = emptySummary();
                    setAlertCache(summary);
                    this.applyAssistSummary(summary);
                    return;
                }
                if (!silent) {
                    wx.showToast({
                        title: detail.message,
                        icon: 'none',
                    });
                }
            }
        },

        async markAssistAlertsRead(activeId = '') {
            try {
                const summary = await callAssist('mark_sign_notifications_read', activeId ? { activeId } : {});
                setAlertCache(summary);
                this.applyAssistSummary(summary);
            } catch (error) {
                // Keep the component quiet here to avoid interrupting navigation.
            }
        },

        onTouchStart() {
            this.setData({ isDragging: true });
        },

        onBtnMove(event) {
            this._lastX = event.detail.x;
            this._lastY = event.detail.y;
            if (event.detail.source === 'touch' && !this.data.isDragging) {
                this.setData({ isDragging: true });
            }
        },

        onTouchEnd() {
            this.setData({ isDragging: false });
            const query = this.createSelectorQuery();
            query.select('.floating-btn').boundingClientRect((rect) => {
                if (!rect) {
                    return;
                }
                const targetX = this._lastX < (this._windowWidth - rect.width) / 2
                    ? 12
                    : this._windowWidth - rect.width - 12;
                this.setData({
                    btnX: targetX,
                    btnY: this._lastY,
                }, () => {
                    app.notifyMsgBoxStateChange({
                        x: targetX,
                        y: this._lastY,
                    });
                });
            }).exec();
        },

        toggleMsgBox() {
            if (this.data.isAnimating) {
                return;
            }
            if (this.data.showMsgBox) {
                this.setData({
                    msgBoxAnimateClass: 'animate-ripple-out',
                    isAnimating: true,
                });
                setTimeout(() => {
                    this.closeOverlayImmediately();
                }, 240);
                return;
            }

            if (typeof app.notifyMsgBoxStateChange === 'function') {
                app.notifyMsgBoxStateChange({ hasNewMsg: false });
            }
            if (this.data.assistUnreadCount > 0) {
                this.markAssistAlertsRead();
            }
            this.setData({
                clickX: this._lastX + 40,
                clickY: this._lastY + 28,
                showMsgBox: true,
                msgBoxAnimateClass: 'animate-ripple',
                hasNewMsg: false,
                isAnimating: true,
            });
            setTimeout(() => {
                this.setData({ isAnimating: false });
            }, 240);
        },

        closeOverlayImmediately() {
            this.setData({
                showMsgBox: false,
                msgBoxAnimateClass: '',
                isAnimating: false,
            });
        },

        // 已迁移至 calculateNextCourse 和 generateTips


        rotateTip() {
            const tips = this.data.tips;
            if (!tips || tips.length < 2) {
                return;
            }
            const nextIndex = (this.data.currentTipIndex + 1) % tips.length;
            this.setData({
                currentTipIndex: nextIndex,
                currentTip: tips[nextIndex],
            });
        },

        openNotification(event) {
            const item = event.currentTarget.dataset.item;
            if (item && item.isSign && item.canHandle) {
                this.openSignAlert(item);
            }
        },

        openSignAlert(item) {
            if (!item) {
                return;
            }

            if (item.activeId) {
                this.markAssistAlertsRead(item.activeId);
            }

            if (!item.canOpen) {
                wx.showModal({
                    title: '当前暂不支持',
                    content: item.helperText || '这类签到当前还不能直接在小程序里完成。',
                    showCancel: false,
                });
                return;
            }

            const query = [
                `courseId=${encodeURIComponent(item.courseId || '')}`,
                `activeId=${encodeURIComponent(item.activeId || '')}`,
                `courseName=${encodeURIComponent(item.courseName || '')}`,
                `activityName=${encodeURIComponent(item.activityName || '')}`,
                `signType=${encodeURIComponent(item.signType || '')}`,
            ].join('&');

            this.closeOverlayImmediately();
            wx.navigateTo({
                url: `/pages/assist/sign/index?${query}`,
            });
        },

        openAssistHome() {
            this.closeOverlayImmediately();
            wx.switchTab({
                url: '/pages/assist/index/index',
            });
        },

        clearScheduleCache() {
            wx.showModal({
                title: '确认清空？',
                content: '这将从本地清除已解析的课表数据，你需要重新上传或同步。',
                confirmColor: '#ff3b30',
                success: (res) => {
                    if (res.confirm) {
                        // 1. 清理 Storage
                        wx.removeStorageSync('schedule_data');
                        wx.removeStorageSync('schedule_id');
                        
                        // 2. 清理全局变量
                        app.globalData.scheduleData = null;
                        app.globalData.scheduleId = null;
                        
                        // 3. 即时刷新 UI (重算周次并更新卡片)
                        const startStr = this.data.semesterStart || '2026-03-02';
                        const semesterStart = new Date(`${startStr}T00:00:00`);
                        const now = new Date();
                        const diffDays = Math.floor((now.getTime() - semesterStart.getTime()) / (24 * 3600 * 1000));
                        const currentWeek = Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));
                        
                        const nextData = this.calculateNextCourse(currentWeek);
                        this.setData({ 
                            currentWeek,
                            ...nextData,
                        });

                        // 4. 同步刷新当前页面（如果它是课表页）
                        const pages = getCurrentPages();
                        const curPage = pages[pages.length - 1];
                        if (curPage && typeof curPage.loadScheduleData === 'function') {
                            curPage.loadScheduleData();
                        }

                        wx.showToast({
                            title: '已重置本地数据',
                            icon: 'success'
                        });
                    }
                }
            });
        },
    },
});
