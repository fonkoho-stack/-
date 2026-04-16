// 云函数：get_schedule
// 功能：查询/更新用户课表数据
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function toTimestamp(value) {
    if (!value) {
        return 0;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    }
    if (typeof value === 'object') {
        if (typeof value.$date === 'string') {
            const parsed = Date.parse(value.$date);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        if (typeof value.seconds === 'number') {
            return value.seconds * 1000;
        }
        if (typeof value.toDate === 'function') {
            try {
                const dateValue = value.toDate();
                if (dateValue instanceof Date) {
                    return dateValue.getTime();
                }
            } catch (error) {
                return 0;
            }
        }
    }
    return 0;
}

function pickLatestScheduleRecord(rows) {
    const list = Array.isArray(rows) ? [...rows] : [];
    if (!list.length) {
        return null;
    }
    list.sort((left, right) => {
        const leftCreatedTs = toTimestamp(left.created_at);
        const rightCreatedTs = toTimestamp(right.created_at);
        if (rightCreatedTs !== leftCreatedTs) {
            return rightCreatedTs - leftCreatedTs;
        }
        const leftUpdatedTs = toTimestamp(left.updated_at || left.created_at);
        const rightUpdatedTs = toTimestamp(right.updated_at || right.created_at);
        return rightUpdatedTs - leftUpdatedTs;
    });
    return list[0] || null;
}

async function queryLatestScheduleRecord(openid, orderField) {
    const res = await db.collection('schedules')
        .where({ openid })
        .orderBy(orderField, 'desc')
        .limit(1)
        .get();
    const rows = Array.isArray(res.data) ? res.data : [];
    return rows[0] || null;
}

async function getLatestScheduleRecord(openid) {
    let latest = null;

    try {
        latest = await queryLatestScheduleRecord(openid, 'created_at');
    } catch (createdAtError) {
        console.warn('getLatestScheduleRecord(created_at) failed:', openid, createdAtError);
    }

    if (!latest) {
        try {
            latest = await queryLatestScheduleRecord(openid, 'updated_at');
        } catch (updatedAtError) {
            console.warn('getLatestScheduleRecord(updated_at) failed:', openid, updatedAtError);
        }
    }

    if (!latest) {
        try {
            const res = await db.collection('schedules')
                .where({ openid })
                .limit(100)
                .get();
            latest = pickLatestScheduleRecord(res.data);
        } catch (fallbackError) {
            console.warn('getLatestScheduleRecord(fallback) failed:', openid, fallbackError);
        }
    }

    return latest;
}

async function resolveScheduleRecord(openid, scheduleId) {
    const latest = await getLatestScheduleRecord(openid);
    if (latest) {
        return latest;
    }
    if (!scheduleId) {
        return null;
    }
    try {
        const res = await db.collection('schedules').doc(scheduleId).get();
        const record = res.data || null;
        if (record && record.openid === openid) {
            return record;
        }
    } catch (error) {
        console.warn('resolveScheduleRecord by id failed:', openid, scheduleId, error);
    }
    return null;
}

async function listSchedulesByOpenid(openid) {
    try {
        const res = await db.collection('schedules')
            .where({ openid })
            .limit(100)
            .get();
        return Array.isArray(res.data) ? res.data : [];
    } catch (error) {
        console.warn('listSchedulesByOpenid failed:', openid, error);
        return [];
    }
}

async function cleanupOldSchedules(openid) {
    const rows = await listSchedulesByOpenid(openid);
    const latest = pickLatestScheduleRecord(rows);
    if (!latest || !latest._id) {
        return {
            kept_schedule_id: '',
            deleted_schedule_ids: [],
            deleted_count: 0,
            total_count: rows.length,
        };
    }

    const staleRows = rows.filter((item) => String(item._id || '') !== String(latest._id));
    const deletedScheduleIds = [];

    for (const item of staleRows) {
        const docId = String(item && item._id || '');
        if (!docId) {
            continue;
        }
        await db.collection('schedules').doc(docId).remove();
        deletedScheduleIds.push(docId);
    }

    return {
        kept_schedule_id: String(latest._id),
        deleted_schedule_ids: deletedScheduleIds,
        deleted_count: deletedScheduleIds.length,
        total_count: rows.length,
    };
}

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
                const latest = await getLatestScheduleRecord(openid);
                if (!latest) {
                    return { success: true, data: null };
                }
                return { success: true, data: latest };
            }

            // 更新课表（用户校对后保存）
            case 'update': {
                if (!events) {
                    return { success: false, error: { code: 'MISSING_PARAMS', message: '缺少参数' } };
                }
                const target = await resolveScheduleRecord(openid, schedule_id);
                if (!target || !target._id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少有效 schedule_id' } };
                }
                await db.collection('schedules').doc(target._id).update({
                    data: {
                        events,
                        updated_at: db.serverDate()
                    }
                });
                return { success: true, data: { schedule_id: target._id } };
            }

            // 增加订阅次数（领票）
            case 'add_sub': {
                const target = await resolveScheduleRecord(openid, schedule_id);
                if (!target || !target._id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少有效 schedule_id' } };
                }
                const _ = db.command;
                await db.collection('schedules').doc(target._id).update({
                    data: {
                        subscription_count: _.inc(1),
                        updated_at: db.serverDate()
                    }
                });
                // 重新获取最新数量返回给前端展示
                const fresh = await db.collection('schedules').doc(target._id).get();
                return {
                    success: true,
                    data: {
                        schedule_id: target._id,
                        subscription_count: fresh.data.subscription_count || 0
                    }
                };
            }


            // 获取订阅额度
            case 'get_sub_count': {
                const target = await resolveScheduleRecord(openid, schedule_id);
                if (!target || !target._id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少有效 schedule_id' } };
                }
                const res = await db.collection('schedules').doc(target._id).get();
                return {
                    success: true,
                    data: {
                        schedule_id: target._id,
                        subscription_count: res.data.subscription_count || 0
                    }
                };
            }

            // 更新提醒设置（同步到云端）
            case 'update_reminder': {
                const { reminder_settings } = event;
                if (!reminder_settings) {
                    return { success: false, error: { code: 'MISSING_PARAMS', message: '缺少参数' } };
                }
                const target = await resolveScheduleRecord(openid, schedule_id);
                if (!target || !target._id) {
                    return { success: false, error: { code: 'MISSING_ID', message: '缺少有效 schedule_id' } };
                }
                await db.collection('schedules').doc(target._id).update({
                    data: {
                        reminder_settings,
                        updated_at: db.serverDate()
                    }
                });
                return { success: true, data: { schedule_id: target._id } };
            }

            case 'cleanup_old_schedules': {
                const result = await cleanupOldSchedules(openid);
                return { success: true, data: result };
            }

            default:
                return { success: false, error: { code: 'INVALID_ACTION', message: '无效操作: ' + action } };
        }
    } catch (err) {
        console.error('get_schedule 执行失败:', err);
        return { success: false, error: { code: 'DB_ERROR', message: err.message } };
    }
};
