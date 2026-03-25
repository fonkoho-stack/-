// components/msg-box/msg-box.js
const app = getApp();
// 已移除后端请求依赖，改为纯本地 Mock 模式
// import { API_BASE_URL } from '../../config';

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

function isEventInWeek(ev, week) {
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
}

Component({
    properties: {
        customNav: {
            type: Boolean,
            value: false
        }
    },
    data: {
        showMsgBox: false,
        btnX: 300,
        btnY: 500,
        clickX: 0,
        clickY: 0,
        msgBoxAnimateClass: '',
        hasNewMsg: true,
        isSyncing: true, 
        isDragging: false, 
        useAnimation: false, 
        hasSchedule: false, 
        isTodayFree: false, 
        nextCourse: null,
        publicEvents: [],
        currentEventIndex: 0,
        currentEvent: null,
        notifications: [
            { id: 1, icon: '🌟', title: '系统更新', desc: '消息盒子现已支持全局显示' },
            { id: 2, icon: '📅', title: '智能提醒', desc: '时刻关注您的下一节课程' }
        ]
    },

    lifetimes: {
        attached() {
            const windowInfo = wx.getWindowInfo();
            this._windowWidth = windowInfo.windowWidth;
            
            let state = app.globalData.msgBoxState;
            if (!state || state.x === undefined) {
                state = wx.getStorageSync('msg_box_state') || { x: 300, y: 500, hasNewMsg: true };
                app.globalData.msgBoxState = state;
            }
            
            this.setData({
                btnX: Number(state.x) || 300,
                btnY: Number(state.y) || 500,
                hasNewMsg: state.hasNewMsg !== false,
                isSyncing: true, 
                useAnimation: false 
            }, () => {
                setTimeout(() => {
                    this.setData({ isSyncing: false, useAnimation: true });
                }, 150);
            });
            this._lastX = Number(state.x) || 300;
            this._lastY = Number(state.y) || 500;

            this.updateDateAndCourse();
            this.fetchPublicEvents();
            
            this._stateWatcher = (state) => {
                if (this._isSelfMoving) return;
                this.setData({
                    isSyncing: true,
                    useAnimation: false,
                    btnX: state.x,
                    btnY: state.y,
                    hasNewMsg: state.hasNewMsg
                }, () => {
                    setTimeout(() => this.setData({ isSyncing: false, useAnimation: true }), 80);
                });
                this._lastX = state.x;
                this._lastY = state.y;
            };
            
            if (!app.globalData.msgBoxWatchers) app.globalData.msgBoxWatchers = [];
            app.globalData.msgBoxWatchers.push(this._stateWatcher);

            this.refreshTimer = setInterval(() => {
                this.updateDateAndCourse();
            }, 60000);
            
            this.rotateTimer = setInterval(() => {
                this.rotateEvent();
            }, 5000);
        },
        detached() {
            if (this.refreshTimer) clearInterval(this.refreshTimer);
            if (this.rotateTimer) clearInterval(this.rotateTimer);
            
            if (app.globalData.msgBoxWatchers) {
                const watchers = app.globalData.msgBoxWatchers;
                const idx = watchers.indexOf(this._stateWatcher);
                if (idx > -1) watchers.splice(idx, 1);
            }
        }
    },

    pageLifetimes: {
        show() {
            const state = app.globalData.msgBoxState || wx.getStorageSync('msg_box_state') || {x:300, y:500, hasNewMsg:true};
            this.setData({
                isSyncing: true,
                useAnimation: false,
                btnX: state.x,
                btnY: state.y,
                hasNewMsg: state.hasNewMsg
            }, () => {
                setTimeout(() => this.setData({ isSyncing: false, useAnimation: true }), 100);
            });
            this._lastX = state.x;
            this._lastY = state.y;
            this.updateDateAndCourse();
        },
        hide() {
            if (this.data.showMsgBox) {
                this.setData({ showMsgBox: false, msgBoxAnimateClass: '' });
            }
        }
    },

    methods: {
        updateDateAndCourse() {
            const semesterStartStr = wx.getStorageSync('semester_start') || '2026-03-02';
            const semesterStart = new Date(semesterStartStr + 'T00:00:00');
            const now = new Date();
            const diffDays = Math.floor((now.getTime() - semesterStart.getTime()) / (24 * 3600 * 1000));
            const currentWeek = Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));
            this.findNextCourse(currentWeek);
        },

        onTouchStart() {
            this.setData({ isDragging: true });
        },

        onBtnMove(e) {
            this._lastX = e.detail.x;
            this._lastY = e.detail.y;
            if (e.detail.source === 'touch' && !this.data.isDragging) {
                this.setData({ isDragging: true });
            }
        },

        onTouchEnd() {
            this.setData({ isDragging: false });
            const query = this.createSelectorQuery();
            query.select('.floating-btn').boundingClientRect(rect => {
                if (!rect) return;
                let targetX = this._lastX < (this._windowWidth - rect.width) / 2 ? 10 : this._windowWidth - rect.width - 10;
                this.setData({ btnX: targetX, btnY: this._lastY }, () => {
                    app.notifyMsgBoxStateChange({ x: targetX, y: this._lastY });
                });
            }).exec();
        },

        toggleMsgBox(e) {
            if (this.data.isAnimating) return; // 动画锁定：防止连点导致动画异常

            if (this.data.showMsgBox) {
                this.setData({ msgBoxAnimateClass: 'animate-ripple-out', isAnimating: true });
                setTimeout(() => {
                    this.setData({ showMsgBox: false, msgBoxAnimateClass: '', isAnimating: false });
                }, 800); 
            } else {
                if (app.notifyMsgBoxStateChange) {
                    app.notifyMsgBoxStateChange({ hasNewMsg: false });
                }
                this.setData({
                    clickX: this._lastX + 25,
                    clickY: this._lastY + 25,
                    showMsgBox: true,
                    msgBoxAnimateClass: 'animate-ripple',
                    hasNewMsg: false,
                    isAnimating: true
                });
                setTimeout(() => {
                    this.setData({ isAnimating: false });
                }, 800);
            }
        },

        findNextCourse(currentWeek) {
            const allEvents = app.globalData.scheduleData || wx.getStorageSync('schedule_data');
            if (!allEvents || allEvents.length === 0) {
                this.setData({ nextCourse: null, hasSchedule: false });
                return;
            }
            this.setData({ hasSchedule: true });

            const now = new Date();
            const currentDay = now.getDay() === 0 ? 7 : now.getDay();
            const currentTotalMins = now.getHours() * 60 + now.getMinutes();
            
            // 获取用户设置的提前提醒时间
            const settings = wx.getStorageSync('reminder_settings') || { leadMinutes: 15 };
            const leadMins = settings.leadMinutes || 15;

            let next = null;
            let minDiff = Infinity;
            const todayEvents = allEvents.filter(ev => 
                ev.day_of_week === currentDay && isEventInWeek(ev, currentWeek)
            );

            if (todayEvents.length === 0) {
                this.setData({ nextCourse: null, isTodayFree: true });
                return;
            }

            for (const ev of todayEvents) {
                const startTimeStr = PERIOD_MAP[ev.time.period_start].start;
                const [h, m] = startTimeStr.split(':').map(Number);
                const eventTotalMins = h * 60 + m;
                const diffMins = eventTotalMins - currentTotalMins;

                // 状态判断：尊重用户设置的提前提醒时间
                if (diffMins > 0 && diffMins < minDiff) {
                    minDiff = diffMins;
                    next = {
                        ...ev,
                        startTime: startTimeStr,
                        location: ev.location?.building ? `${ev.location.building}${ev.location.room || ''}` : (ev.location?.raw || '未知'),
                        countdown: diffMins > 60 ? `约 ${Math.floor(diffMins / 60)} 小时后` : `${diffMins} 分钟后`,
                        isUpcoming: diffMins <= leadMins // 新增属性：是否处于即将开始状态
                    };
                }
            }
            this.setData({ nextCourse: next, isTodayFree: false });
        },

        fetchPublicEvents() {
            // 已脱离后端，直接使用本地精选 Mock 数据提供预览
            const mockEvents = [
                {
                    id: 'm1',
                    event_name: '期末统考：深度学习概论',
                    event_date: '2026-06-15T09:00:00',
                    date_formatted: '2026-06-15',
                    location: '大礼堂 A-101',
                    description: '请携带学生证准时参加。'
                },
                {
                    id: 'm2',
                    event_name: '校园开放日：未来科技展',
                    event_date: '2026-04-20T14:00:00',
                    date_formatted: '2026-04-20',
                    location: '科技馆 2 楼',
                    description: '体验最先进的人工智能交互设备。'
                }
            ];
            
            this.setData({
                publicEvents: mockEvents,
                currentEvent: mockEvents[0],
                currentEventIndex: 0
            });
            console.log('✅ 已切换至本地全量数据模式，无需运行后端服务。');
        },

        rotateEvent() {
            const events = this.data.publicEvents;
            if (events && events.length > 1) {
                let nextIndex = (this.data.currentEventIndex + 1) % events.length;
                this.setData({
                    currentEventIndex: nextIndex,
                    currentEvent: events[nextIndex]
                });
            }
        }
    }
});
