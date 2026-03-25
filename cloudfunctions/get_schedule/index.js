// 云函数：get_schedule
// 功能：查询/更新用户课表数据
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const { action, schedule_id, events } = event;

    try {
        switch (action) {
            // 按 ID 查询
            case 'get': {
                if (!schedule_id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少 schedule_id' } };
                }
                const res = await db.collection('schedules').doc(schedule_id).get();
                return { success: true, data: res.data };
            }

            // 查询当前用户最新课表
            case 'latest': {
                const res = await db.collection('schedules')
                    .where({ openid })
                    .orderBy('created_at', 'desc')
                    .limit(1)
                    .get();
                if (res.data.length === 0) {
                    return { success: true, data: null };
                }
                return { success: true, data: res.data[0] };
            }

            // 更新课表（用户校对后保存）
            case 'update': {
                if (!schedule_id || !events) {
                    return { success: false, error: { code: 'MISSING_PARAMS', message: '缺少参数' } };
                }
                await db.collection('schedules').doc(schedule_id).update({
                    data: {
                        events,
                        updated_at: db.serverDate()
                    }
                });
                return { success: true, data: { schedule_id } };
            }

            // 增加订阅次数（领票）
            case 'add_sub': {
                if (!schedule_id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少 schedule_id' } };
                }
                const _ = db.command;
                await db.collection('schedules').doc(schedule_id).update({
                    data: {
                        subscription_count: _.inc(1),
                        updated_at: db.serverDate()
                    }
                });
                // 重新获取最新数量返回给前端展示
                const fresh = await db.collection('schedules').doc(schedule_id).get();
                return { success: true, data: { subscription_count: fresh.data.subscription_count || 0 } };
            }


            // 获取订阅额度
            case 'get_sub_count': {
                if (!schedule_id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少 schedule_id' } };
                }
                const res = await db.collection('schedules').doc(schedule_id).get();
                return { success: true, data: { subscription_count: res.data.subscription_count || 0 } };
            }

            // 更新提醒设置（同步到云端）
            case 'update_reminder': {
                const { reminder_settings } = event;
                if (!schedule_id || !reminder_settings) {
                    return { success: false, error: { code: 'MISSING_PARAMS', message: '缺少参数' } };
                }
                await db.collection('schedules').doc(schedule_id).update({
                    data: {
                        reminder_settings,
                        updated_at: db.serverDate()
                    }
                });
                return { success: true };
            }

            default:
                return { success: false, error: { code: 'INVALID_ACTION', message: '无效操作: ' + action } };
        }
    } catch (err) {
        console.error('get_schedule 执行失败:', err);
        return { success: false, error: { code: 'DB_ERROR', message: err.message } };
    }
};
