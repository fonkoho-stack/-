const { callAssist, normalizeError, formatTimeText } = require('../../../utils/assist');

function getStatusText(item) {
    if (!item || !item.status) {
        return '已结束';
    }
    if (item.activeType === 'signIn' || item.activeType === 'signOut' || item.activeType === 'scheduledSignIn') {
        return '进行中';
    }
    return '活动中';
}

Page({
    data: {
        loading: true,
        errorText: '',
        courseId: '',
        classId: '',
        cpi: '',
        courseName: '',
        activities: [],
    },

    onLoad(options) {
        this.setData({
            courseId: options.courseId || '',
            classId: options.classId || '',
            cpi: options.cpi || '',
            courseName: decodeURIComponent(options.courseName || '课程活动'),
        });
        wx.setNavigationBarTitle({
            title: this.data.courseName || '课程活动',
        });
    },

    onShow() {
        this.loadActivities();
    },

    async onPullDownRefresh() {
        await this.loadActivities(false);
        wx.stopPullDownRefresh();
    },

    async loadActivities(showLoading = true) {
        if (showLoading) {
            this.setData({ loading: true, errorText: '' });
        }
        try {
            const result = await callAssist('list_activities', {
                courseId: this.data.courseId,
                classId: this.data.classId,
                cpi: this.data.cpi,
            });
            const activities = (result.activities || []).map((item) => ({
                ...item,
                startTimeText: formatTimeText(item.startTime),
                statusText: getStatusText(item),
            }));
            this.setData({
                loading: false,
                activities,
                errorText: '',
            });
        } catch (error) {
            const detail = normalizeError(error, '加载活动失败');
            this.setData({
                loading: false,
                activities: [],
                errorText: detail.message,
            });
            wx.showToast({ title: detail.message, icon: 'none' });
        }
    },

    openActivity(e) {
        const item = e.currentTarget.dataset.item;
        if (!item) {
            return;
        }
        if (!item.isSupported) {
            wx.showToast({
                title: item.supportReason || '该活动类型一期暂不支持',
                icon: 'none',
            });
            return;
        }
        const query = [
            `courseId=${encodeURIComponent(this.data.courseId)}`,
            `activeId=${encodeURIComponent(item.id)}`,
            `courseName=${encodeURIComponent(this.data.courseName)}`,
            `activityName=${encodeURIComponent(item.name)}`,
            `signType=${encodeURIComponent(item.signType || '')}`,
        ].join('&');
        wx.navigateTo({
            url: `/pages/assist/sign/index?${query}`,
        });
    },
});
