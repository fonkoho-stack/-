// pages/schedule/schedule.js
const app = getApp();

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
    12: { start: '22:15', end: '23:00' }
};

Page({
    data: {
        viewMode: 'today',
        hasData: false,
        realWeek: 1,    // 真实周次（今日视图专用，不受翻页影响）
        gridWeek: 1,    // 全周网格视图的浏览周次（翻页时变化）
        currentDay: 1,
        todayDateStr: '',
        weekEvents: [],
        todayEvents: [],
        nextEvent: null,
        subscriptionCount: 0,
        showDetailPopup: false,
        detailEvent: null
    },

    onLoad() {
        this.initDate();
        const savedViewMode = wx.getStorageSync('schedule_view_mode');
        if (savedViewMode) {
            this.setData({ viewMode: savedViewMode });
        }
        this.loadScheduleData();
    },

    onShow() {
        if (app.globalData.subscriptionCount !== undefined) {
            this.setData({ subscriptionCount: app.globalData.subscriptionCount });
        }
        this.fetchSubscriptionCount();
        this.loadScheduleData();
    },

    switchView(e) {
        const mode = e.currentTarget.dataset.mode;
        this.setData({ viewMode: mode });
        wx.setStorageSync('schedule_view_mode', mode);
    },

    initDate() {
        const now = new Date();
        const currentDay = now.getDay() === 0 ? 7 : now.getDay();

        const semesterStartStr = wx.getStorageSync('semester_start') || '2026-03-02';
        const semesterStart = new Date(semesterStartStr + 'T00:00:00');
        const diffDays = Math.floor((now.getTime() - semesterStart.getTime()) / (24 * 3600 * 1000));
        const currentWeek = Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));

        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const hour = now.getHours();
        const timeEmoji = (hour >= 6 && hour < 18) ? '☀️' : '🌙';
        const todayDateStr = (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + dayNames[now.getDay()] + ' ' + timeEmoji;

        this.setData({
            currentDay,
            realWeek: currentWeek,
            gridWeek: currentWeek,
            todayDateStr
        });
    },

    loadScheduleData() {
        const data = app.globalData.scheduleData || wx.getStorageSync('schedule_data');
        if (data && data.length > 0) {
            this.setData({ hasData: true });
            this.processEvents(data);
        } else {
            this.setData({ hasData: false });
            this.setData({ weekEvents: [], todayEvents: [], nextEvent: null });
        }
    },

    processEvents(allEvents) {
        const gridWeek = this.data.gridWeek;   // 全周网格用
        const realWeek = this.data.realWeek;   // 今日视图用
        const now = new Date();
        const settings = wx.getStorageSync('reminder_settings') || { leadMinutes: 15 };
        const leadMins = settings.leadMinutes || 15;

        const enrichedEvents = allEvents.map((ev, idx) => {
            const startStr = PERIOD_MAP[ev.time.period_start]?.start || '';
            const endStr = PERIOD_MAP[ev.time.period_end]?.end || '';

            // Calculate duration in minutes for timeline rendering
            let durationMinutes = 45;
            let m1 = 0;
            let m2 = 0;
            if (startStr && endStr) {
                const parts1 = startStr.split(':');
                const parts2 = endStr.split(':');
                m1 = parseInt(parts1[0]) * 60 + parseInt(parts1[1]);
                m2 = parseInt(parts2[0]) * 60 + parseInt(parts2[1]);
                durationMinutes = m2 - m1;
                if (durationMinutes < 0) durationMinutes = 45;
            }

            // 增强：计算实时状态（尊重用户设置的提醒时间）
            const currentMins = now.getHours() * 60 + now.getMinutes();
            let status = '';
            let statusIcon = '📖';

            if (currentMins >= m1 && currentMins <= m2) {
                status = '进行中';
                statusIcon = '⚡';
            } else if (currentMins < m1 && currentMins >= m1 - leadMins) {
                status = '即将开始';
                statusIcon = '🔔';
            }

            return {
                ...ev,
                startStr,
                endStr,
                timeStr: `${startStr}-${endStr}`,
                locStr: (ev.location.campus || '') + ' ' + (ev.location.room || ''),
                durationMinutes,
                status,
                statusIcon,
                colorIndex: idx % 6 // Matches grad-0 to grad-5
            };
        });

        // Filter for current week grid（全周视图使用 gridWeek）
        const weekEvents = enrichedEvents.filter(ev => this.isEventInWeek(ev, gridWeek));

        // Filter for today's timeline（今日视图始终使用 realWeek，不受翻页影响）
        const realWeekEvents = enrichedEvents.filter(ev => this.isEventInWeek(ev, realWeek));
        const todayDayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
        let todayEvents = realWeekEvents.filter(ev => ev.day_of_week === todayDayOfWeek);
        todayEvents.sort((a, b) => a.time.period_start - b.time.period_start);

        // Determine Next Event
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        let nextEvent = null;
        for (let ev of todayEvents) {
            if (!ev.timeStr) continue;
            const endParts = ev.timeStr.split('-')[1].split(':');
            const endMinutes = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
            if (nowMinutes < endMinutes) { // Hasn't ended yet
                nextEvent = ev;
                break;
            }
        }

        this.setData({ weekEvents, todayEvents, nextEvent });
    },

    isEventInWeek(ev, week) {
        if (!ev.weeks) return true;
        if (ev.weeks.mode === 'range' && ev.weeks.ranges) {
            for (let r of ev.weeks.ranges) {
                if (week >= r.start && week <= r.end) {
                    if (r.odd_even === 'odd' && week % 2 === 0) continue;
                    if (r.odd_even === 'even' && week % 2 !== 0) continue;
                    return true;
                }
            }
        } else if (ev.weeks.mode === 'list' && ev.weeks.list) {
            return ev.weeks.list.includes(week);
        }
        return false;
    },

    prevWeek() {
        if (this.data.gridWeek > 1) {
            const next = this.data.gridWeek - 1;
            this.setData({ gridWeek: next });
            this.processEvents(app.globalData.scheduleData || wx.getStorageSync('schedule_data'));
        }
    },

    nextWeek() {
        if (this.data.gridWeek < 25) {
            const next = this.data.gridWeek + 1;
            this.setData({ gridWeek: next });
            this.processEvents(app.globalData.scheduleData || wx.getStorageSync('schedule_data'));
        }
    },

    showDetail(e) {
        const event = e.currentTarget.dataset.event;
        const dayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        this.setData({
            showDetailPopup: true,
            detailEvent: {
                ...event,
                dayName: dayNames[event.day_of_week - 1]
            }
        });
    },

    hideDetail() {
        this.setData({ showDetailPopup: false });
    },

    deleteEvent() {
        const eventId = this.data.detailEvent.id;
        wx.showModal({
            title: '删除课程',
            content: `确定要删除「${this.data.detailEvent.course_name}」吗？`,
            confirmColor: '#e74c3c',
            success: (sm) => {
                if (sm.confirm) {
                    let allEvents = app.globalData.scheduleData || wx.getStorageSync('schedule_data') || [];
                    allEvents = allEvents.filter(ev => ev.id !== eventId);

                    app.globalData.scheduleData = allEvents;
                    wx.setStorageSync('schedule_data', allEvents);

                    this.setData({ showDetailPopup: false });
                    this.processEvents(allEvents);

                    wx.showToast({ title: '已删除', icon: 'success' });
                }
            }
        });
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

    goToUpload() {
        wx.switchTab({ url: '/pages/upload/upload' });
    },

    trySilentSubscribe() {
        this.fetchSubscriptionCount();
    }
});
