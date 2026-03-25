const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 订阅消息模板 ID
const TEMPLATE_ID = 'Z565zxBRTt20vIOi6Zo4S2sIqL2mghnFaRg_MPi-M9c';

// 节次→开始时间映射
const PERIOD_START_MAP = {
    1: '08:00', 2: '08:55', 3: '10:00', 4: '10:55',
    5: '14:30', 6: '15:25', 7: '16:30', 8: '17:25',
    9: '19:30', 10: '20:25', 11: '21:20', 12: '22:15'
};

exports.main = async (event, context) => {
    try {
        // 1. 获取北京时间（健壮适配本地调试与云端环境）
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
        const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const currentTimeInMinutes = hour * 60 + minute;

        console.log(`⏰ Reminder Triggered: ${hour}:${minute}, Day ${dayOfWeek}`);

        // 2. 获取有订阅额度的用户
        const allSchedules = await db.collection('schedules')
            .where({
                subscription_count: _.gt(0)
            })
            .limit(100)
            .get();

        console.log(`🔍 Found ${allSchedules.data.length} users with subscription quota.`);

        if (allSchedules.data.length === 0) {
            return { success: true, processed: 0, msg: 'No active subscriptions' };
        }

        const sendPromises = [];
        const sentKeys = new Set();

        // 3. 遍历用户进行匹配
        for (const record of allSchedules.data) {
            const { _id, openid, events, reminder_settings } = record;
            
            // 提醒开关检查
            if (reminder_settings && reminder_settings.reminderEnabled === false) {
                console.log(`⏩ User ${openid} has reminders disabled.`);
                continue;
            }

            const leadMinutes = (reminder_settings && reminder_settings.leadMinutes) ? reminder_settings.leadMinutes : 15;
            const semesterStartStr = (reminder_settings && reminder_settings.semesterStart) ? reminder_settings.semesterStart : '2026-03-02';
            
            // 计算当前该用户的周次
            const semesterStart = new Date(semesterStartStr + 'T00:00:00+08:00');
            const diffDays = Math.floor((now.getTime() - semesterStart.getTime()) / (24 * 3600 * 1000));
            const currentWeek = Math.floor(diffDays / 7) + 1;

            console.log(`👤 Processing User ${openid}: Week ${currentWeek}, Lead ${leadMinutes}m`);

            if (currentWeek < 1 || currentWeek > 25) {
                console.log(`⏩ User ${openid} is outside semester weeks (${currentWeek}).`);
                continue;
            }

            for (const ev of (events || [])) {
                // 匹配日期
                if (ev.day_of_week !== dayOfWeek) continue;
                
                // 匹配周次
                if (!isEventInWeek(ev, currentWeek)) continue;

                // 匹配时间窗口
                const pStart = ev.time.period_start;
                const startTimeStr = PERIOD_START_MAP[pStart];
                if (!startTimeStr) continue;

                const [sH, sM] = startTimeStr.split(':').map(Number);
                const startTimeInMinutes = sH * 60 + sM;
                const diff = startTimeInMinutes - currentTimeInMinutes;

                console.log(`   📖 Course: ${ev.course_name}, Starts at ${startTimeStr}, Diff: ${diff}m`);

                // 触发窗口：[lead-5, lead]
                if (diff >= (leadMinutes - 5) && diff <= leadMinutes) {
                    console.log(`   🚀 MATCHED! Preparing to send.`);
                    const dedupeKey = `${openid}_${ev.course_name}_${pStart}`;
                    if (sentKeys.has(dedupeKey)) continue;
                    sentKeys.add(dedupeKey);

                    sendPromises.push(
                        sendReminderMessage(openid, _id, ev, startTimeStr)
                    );
                }
            }
        }

        const results = await Promise.all(sendPromises);
        return { success: true, processed: results.length, results };

    } catch (err) {
        console.error('❌ Reminder system error:', err);
        return { success: false, error: err.message };
    }
};

/**
 * 判断课程是否在指定周次内
 */
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

/**
 * 调用 OpenAPI 发送订阅消息并扣除额度
 */
async function sendReminderMessage(openid, scheduleId, ev, startTimeStr) {
    try {
        const location = (ev.location && (ev.location.room || ev.location.building)) ? 
            `${ev.location.building || ''}${ev.location.room || ''}` : 
            (ev.location.raw || '未知地点');
        const teacher = ev.teacher || '任课老师';

        // 调用云开发内置的 OpenAPI
        const result = await cloud.openapi.subscribeMessage.send({
            touser: openid,
            templateId: TEMPLATE_ID,
            page: 'pages/schedule/schedule',
            data: {
                name3: { value: teacher.substring(0, 5) || '老师' },
                date4: { value: new Date(new Date().getTime() + 8 * 3600 * 1000).toISOString().split('T')[0] },
                time25: { value: startTimeStr },
                thing26: { value: ev.course_name.substring(0, 20) },
                thing27: { value: location.substring(0, 20) }
            }
        });

        if (result.errCode === 0) {
            // 发送成功，扣除额度
            await db.collection('schedules').doc(scheduleId).update({
                data: { subscription_count: _.inc(-1) }
            });
            console.log(`✅ Sent Successfully: ${ev.course_name} to ${openid}`);
        }
        return { openid, success: result.errCode === 0, result };
    } catch (err) {
        console.error(`❌ Send exception to ${openid}:`, err);
        return { openid, success: false, error: err.message };
    }
}
