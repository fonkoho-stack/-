// app.js - 小程序入口（云开发模式）
App({
    globalData: {
        // 缓存的课表数据
        scheduleData: null,
        scheduleId: '',
        currentWeek: 1,
        subscriptionCount: 0,
        msgBoxState: { x: 300, y: 500, hasNewMsg: true },
        msgBoxWatchers: []
    },

    notifyMsgBoxStateChange(newState) {
        this.globalData.msgBoxState = { ...this.globalData.msgBoxState, ...newState };
        // 保存到本地存储
        wx.setStorage({ key: 'msg_box_state', data: this.globalData.msgBoxState });
        // 通知所有活动的 msg-box 组件
        this.globalData.msgBoxWatchers.forEach(watcher => {
            if (typeof watcher === 'function') watcher(this.globalData.msgBoxState);
        });
    },

    onLaunch() {
        // 初始化云开发环境
        if (!wx.cloud) {
            console.error('请使用 2.2.3 或以上的基础库以使用云能力');
        } else {
            wx.cloud.init({
                env: 'cloud1-2gqxkd6t6713a040',
                traceUser: true
            });
        }

        // 从本地存储恢复数据
        const data = wx.getStorageSync('schedule_data');
        const sid = wx.getStorageSync('schedule_id');
        const msgState = wx.getStorageSync('msg_box_state');
        
        if (data) {
            this.globalData.scheduleData = data;
        }
        if (sid) {
            this.globalData.scheduleId = sid;
        }
        if (msgState) {
            this.globalData.msgBoxState = msgState;
        }
    }
});
