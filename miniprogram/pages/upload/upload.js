// pages/upload/upload.js
const app = getApp();

Page({
    data: {
        uploading: false,
        progressPercent: 0,
        progressText: '正在准备上传...',
        steps: [
            { icon: '01', name: '上传课表', desc: '选择 PDF 文件' },
            { icon: '02', name: '智能解析', desc: '自动识别课程' },
            { icon: '03', name: '查看课表', desc: '浏览课程安排' }
        ]
    },

    chooseFile() {
        wx.chooseMessageFile({
            count: 1,
            type: 'file',
            extension: ['pdf'],
            success: (res) => {
                const file = res.tempFiles[0];
                this.startUpload(file);
            }
        });
    },

    startUpload(file) {
        this.setData({ uploading: true, progressPercent: 10, progressText: '正在向云端传输文件...' });
        
        const fileName = `${Date.now()}-${file.name}`;
        wx.cloud.uploadFile({
            cloudPath: `uploads/${fileName}`,
            filePath: file.path,
            success: (res) => {
                this.parseFile(res.fileID);
            },
            fail: (err) => {
                wx.showToast({ title: '上传失败', icon: 'error' });
                this.setData({ uploading: false });
            }
        });
    },

    parseFile(fileID) {
        this.setData({ progressPercent: 40, progressText: '文件上传成功，正在解析内容...' });
        
        wx.cloud.callFunction({
            name: 'parse_schedule',
            data: { fileID: fileID }
        }).then(res => {
            if (res.result && res.result.success) {
                this.setData({ progressPercent: 100, progressText: '解析完成！' });
                app.globalData.scheduleData = res.result.data.events;
                app.globalData.scheduleId = res.result.data.schedule_id;
                wx.setStorageSync('schedule_data', res.result.data.events);
                wx.setStorageSync('schedule_id', res.result.data.schedule_id);
                
                // 引导触发器：导入成功后提示开启提醒
                wx.showModal({
                    title: '🎉 导入成功',
                    content: '您的课表已就绪！是否立即去开启“课前提醒”，确保不旷任何一节课？',
                    cancelText: '稍后再说',
                    confirmText: '去开启',
                    confirmColor: '#34C759',
                    success: (modalRes) => {
                        this.setData({ uploading: false, progressPercent: 0 });
                        if (modalRes.confirm) {
                            app.globalData.triggerRemindGuide = true;
                            wx.switchTab({ url: '/pages/schedule/schedule' });
                        } else {
                            wx.switchTab({ url: '/pages/schedule/schedule' });
                        }
                    }
                });
            } else {
                wx.showToast({ title: '解析失败，请重试', icon: 'none' });
                this.setData({ uploading: false });
            }
        }).catch(err => {
            wx.showToast({ title: '服务器忙', icon: 'none' });
            this.setData({ uploading: false });
        });
    }
});
