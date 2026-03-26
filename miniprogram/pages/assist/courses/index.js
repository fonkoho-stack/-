const { callAssist, normalizeError } = require('../../../utils/assist');

Page({
    data: {
        loading: true,
        courses: [],
        errorText: '',
    },

    onShow() {
        this.loadCourses();
    },

    async onPullDownRefresh() {
        await this.loadCourses(false);
        wx.stopPullDownRefresh();
    },

    async loadCourses(showLoading = true) {
        if (showLoading) {
            this.setData({ loading: true, errorText: '' });
        }
        try {
            const result = await callAssist('list_courses');
            this.setData({
                loading: false,
                courses: result.courses || [],
                errorText: '',
            });
        } catch (error) {
            const detail = normalizeError(error, '加载课程失败');
            this.setData({
                loading: false,
                courses: [],
                errorText: detail.message,
            });
            if (detail.code === 'AUTH_REQUIRED') {
                wx.showModal({
                    title: '需要绑定超星账号',
                    content: '当前还没有可用的超星登录态，请先回到助手首页完成绑定。',
                    showCancel: false,
                    success: () => {
                        wx.navigateBack({
                            fail: () => wx.switchTab({ url: '/pages/assist/index/index' }),
                        });
                    },
                });
                return;
            }
            wx.showToast({ title: detail.message, icon: 'none' });
        }
    },

    openCourse(e) {
        const item = e.currentTarget.dataset.item;
        if (!item) {
            return;
        }
        const query = [
            `courseId=${encodeURIComponent(item.courseId)}`,
            `classId=${encodeURIComponent(item.classId)}`,
            `cpi=${encodeURIComponent(item.cpi)}`,
            `courseName=${encodeURIComponent(item.name)}`,
        ].join('&');
        wx.navigateTo({
            url: `/pages/assist/activities/index?${query}`,
        });
    },
});
