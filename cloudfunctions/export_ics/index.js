// 云函数：export_ics
// 功能：根据 schedule_id 生成 ICS 日历文件并上传到云存储，返回临时下载链接
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 节次 → 时间映射
const PERIOD_MAP = {
    1: ['08:00', '09:40'], 2: ['08:55', '09:40'],
    3: ['10:00', '11:40'], 4: ['10:45', '11:40'],
    5: ['14:30', '17:15'], 6: ['15:25', '17:15'],
    7: ['14:30', '16:10'], 8: ['16:20', '18:00'],
    9: ['19:00', '20:40'], 10: ['19:55', '20:40'],
    11: ['21:00', '22:40'], 12: ['21:45', '22:40']
};

/**
 * 根据周次配置展开为具体周列表
 */
function expandWeeks(weeks) {
    const result = [];
    if (weeks.mode === 'range' && weeks.ranges) {
        for (const r of weeks.ranges) {
            for (let w = r.start; w <= r.end; w++) {
                if (r.odd_even === 'odd' && w % 2 === 0) continue;
                if (r.odd_even === 'even' && w % 2 !== 0) continue;
                result.push(w);
            }
        }
    } else if (weeks.mode === 'list' && weeks.list) {
        result.push(...weeks.list);
    }
    return result;
}

/**
 * 格式化日期为 ICS 格式: YYYYMMDDTHHmmSS
 */
function formatICSDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

/**
 * 生成 ICS 内容
 */
function generateICS(events, week1Monday) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//校园课表助手//CN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:我的课表',
        'X-WR-TIMEZONE:Asia/Shanghai'
    ];

    const baseDate = new Date(week1Monday + 'T00:00:00+08:00');

    for (const ev of events) {
        const weekList = expandWeeks(ev.weeks);
        const dayOffset = (ev.day_of_week || 1) - 1;

        // 获取时间
        let startTime = '08:00';
        let endTime = '09:40';
        if (ev.time && ev.time.period_start && PERIOD_MAP[ev.time.period_start]) {
            startTime = PERIOD_MAP[ev.time.period_start][0];
        }
        if (ev.time && ev.time.period_end && PERIOD_MAP[ev.time.period_end]) {
            endTime = PERIOD_MAP[ev.time.period_end][1];
        }

        for (const week of weekList) {
            // 计算具体日期：第 week 周的第 dayOfWeek 天
            const msOffset = ((week - 1) * 7 + dayOffset) * 86400000;
            const eventDate = new Date(baseDate.getTime() + msOffset);

            const [sh, sm] = startTime.split(':').map(Number);
            const [eh, em] = endTime.split(':').map(Number);

            const dtStart = new Date(eventDate);
            dtStart.setHours(sh, sm, 0, 0);
            const dtEnd = new Date(eventDate);
            dtEnd.setHours(eh, em, 0, 0);

            const locStr = ev.location?.raw || ev.location?.building || '';

            lines.push('BEGIN:VEVENT');
            lines.push(`DTSTART;TZID=Asia/Shanghai:${formatICSDate(dtStart)}`);
            lines.push(`DTEND;TZID=Asia/Shanghai:${formatICSDate(dtEnd)}`);
            lines.push(`SUMMARY:${ev.course_name}`);
            lines.push(`LOCATION:${locStr}`);
            lines.push(`DESCRIPTION:教师: ${ev.teacher || '未知'}\\n地点: ${locStr}`);
            if (ev.reminder?.enabled && ev.reminder?.lead_minutes) {
                lines.push('BEGIN:VALARM');
                lines.push('TRIGGER:-PT' + ev.reminder.lead_minutes + 'M');
                lines.push('ACTION:DISPLAY');
                lines.push(`DESCRIPTION:${ev.course_name} 即将上课`);
                lines.push('END:VALARM');
            }
            lines.push(`UID:${ev.id}-w${week}@course-reminder`);
            lines.push('END:VEVENT');
        }
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
}

exports.main = async (event, context) => {
    const { schedule_id, week1_monday } = event;

    if (!schedule_id) {
        return { success: false, error: { code: 'MISSING_ID', message: '缺少 schedule_id' } };
    }

    // 默认学期第一周周一（用户可通过设置页面配置）
    const w1m = week1_monday || '2026-02-23';

    try {
        // 1. 查询课表
        const res = await db.collection('schedules').doc(schedule_id).get();
        const schedule = res.data;
        if (!schedule || !schedule.events) {
            return { success: false, error: { code: 'NOT_FOUND', message: '课表不存在' } };
        }

        // 2. 生成 ICS 内容
        const icsContent = generateICS(schedule.events, w1m);

        // 3. 上传到云存储（临时文件）
        const fileName = `ics_exports/${schedule_id}_${Date.now()}.ics`;
        const uploadRes = await cloud.uploadFile({
            cloudPath: fileName,
            fileContent: Buffer.from(icsContent, 'utf-8')
        });

        // 4. 生成临时下载链接
        const urlRes = await cloud.getTempFileURL({
            fileList: [uploadRes.fileID]
        });

        const downloadUrl = urlRes.fileList[0]?.tempFileURL || '';

        return {
            success: true,
            data: {
                fileID: uploadRes.fileID,
                downloadUrl
            }
        };
    } catch (err) {
        console.error('export_ics 执行失败:', err);
        return { success: false, error: { code: 'EXPORT_FAILED', message: err.message } };
    }
};
