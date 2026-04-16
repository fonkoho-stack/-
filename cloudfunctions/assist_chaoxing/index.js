const cloud = require('wx-server-sdk');
const {
    appError,
    buildAccountPatch,
    codeSign,
    createSession,
    fetchActivities,
    fetchCourses,
    fetchUserInfo,
    getActivityDetail,
    locationSign,
    loginByPassword,
    loginBySms,
    normalSign,
    performQrSign,
    photoSign,
    sendSmsCode,
    serializeSession,
    tryCheckSignCode,
} = require('./chaoxing');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ACCOUNT_COLLECTION = 'assist_accounts';
const ALERT_COLLECTION = 'assist_sign_notifications';
const SIGN_CODE_COLLECTION = 'assist_sign_codes';
const SCHEDULE_COLLECTION = 'schedules';
const COURSE_SCAN_CONCURRENCY = 4;
const ACCOUNT_SCAN_CONCURRENCY = 2;
const DETAIL_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

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
    12: { start: '22:15', end: '23:00' },
};

const WATCH_POLICY = {
    defaultSemesterStart: '2026-03-02',
    timerMinIntervalMs: 60 * 1000,
    preheatMinIntervalMs: 60 * 1000,
    preheatMaxIntervalMs: 60 * 1000,
    scanningMinIntervalMs: 60 * 1000,
    scanningMaxIntervalMs: 60 * 1000,
    activeHitMinIntervalMs: 60 * 1000,
    activeHitMaxIntervalMs: 60 * 1000,
    postSignMinIntervalMs: 3 * 60 * 1000,
    postSignMaxIntervalMs: 5 * 60 * 1000,
    sleepFallbackIntervalMs: 12 * 60 * 60 * 1000,
    riskCooldownMs: 40 * 60 * 1000,
    errorBackoffBaseMs: 5 * 60 * 1000,
    errorBackoffMaxMs: 30 * 60 * 1000,
    classWindowLeadMinutes: 15,
    classWindowLeadMinMinutes: 10,
    classWindowLeadMaxMinutes: 30,
    classWindowTailMinutes: 5,
    mergeGapMinutes: 2,
    maxLookupDays: 14,
    debugLogLimit: 40,
};

function success(data = null) {
    return { success: true, data };
}

function failure(error) {
    return {
        success: false,
        error: {
            code: error && error.code ? error.code : 'INTERNAL_ERROR',
            message: error && error.message ? error.message : '操作失败',
        },
    };
}

function normalizeKnownError(error) {
    const message = String((error && error.message) || '');
    if (
        message.includes(`collection ${ACCOUNT_COLLECTION} does not exists`) ||
        message.includes('DATABASE_COLLECTION_NOT_EXIST') && message.includes(ACCOUNT_COLLECTION)
    ) {
        return appError(
            'SETUP_REQUIRED',
            `云开发数据库里还没有 ${ACCOUNT_COLLECTION} 集合，请先手动创建这个集合`
        );
    }
    if (
        message.includes(`collection ${ALERT_COLLECTION} does not exists`) ||
        message.includes('DATABASE_COLLECTION_NOT_EXIST') && message.includes(ALERT_COLLECTION)
    ) {
        return appError(
            'SETUP_REQUIRED',
            `云开发数据库里还没有 ${ALERT_COLLECTION} 集合，请先手动创建这个集合`
        );
    }
    return error;
}

function ensureText(value, code, message) {
    const text = String(value || '').trim();
    if (!text) {
        throw appError(code, message);
    }
    return text;
}

function toIsoText(value) {
    if (!value) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return new Date(value).toISOString();
    } catch (error) {
        return '';
    }
}

function sortAlerts(alerts) {
    return [...alerts].sort((left, right) => {
        const leftTime = new Date(left.startTime || left.detectedAt || 0).getTime();
        const rightTime = new Date(right.startTime || right.detectedAt || 0).getTime();
        return rightTime - leftTime;
    });
}

function buildRecentAlertHistory(records, limit = 8) {
    const historyAlerts = sortAlerts(
        (Array.isArray(records) ? records : [])
            .filter((item) => !item.is_active)
            .map((item) => toClientAlert(item))
    );
    return historyAlerts.slice(0, Math.max(0, limit));
}

function buildAlertSummary(alerts, historyAlerts = []) {
    const readyCount = alerts.filter((item) => item.status === 'ready').length;
    const limitedCount = alerts.filter((item) => item.status === 'limited').length;
    const unreadCount = alerts.filter((item) => !item.isRead).length;
    return {
        alerts,
        historyAlerts,
        unreadCount,
        readyCount,
        limitedCount,
        scannedAt: new Date().toISOString(),
    };
}

async function mapWithConcurrency(items, concurrency, worker) {
    if (!Array.isArray(items) || !items.length) {
        return [];
    }
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(concurrency || 1, items.length));

    async function runWorker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

function toTimestamp(value) {
    if (!value) {
        return 0;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    if (typeof value === 'object') {
        if (typeof value.$date === 'string') {
            const parsed = Date.parse(value.$date);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
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

function parseTimeTextToMinutes(text) {
    const parts = String(text || '').split(':').map((item) => Number(item));
    if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) {
        return null;
    }
    return parts[0] * 60 + parts[1];
}

function clamp(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return min;
    }
    return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function getPeriodBoundaryMinutes(period, boundary = 'start') {
    const info = PERIOD_MAP[Number(period)];
    if (!info) {
        return null;
    }
    return parseTimeTextToMinutes(boundary === 'end' ? info.end : info.start);
}

function isEventInWeek(event, week) {
    if (!event || !event.weeks) {
        return true;
    }
    if (event.weeks.mode === 'range' && Array.isArray(event.weeks.ranges)) {
        for (const range of event.weeks.ranges) {
            const start = Number(range.start);
            const end = Number(range.end);
            if (week < start || week > end) {
                continue;
            }
            if (range.odd_even === 'odd' && week % 2 === 0) {
                continue;
            }
            if (range.odd_even === 'even' && week % 2 !== 0) {
                continue;
            }
            return true;
        }
        return false;
    }
    if (event.weeks.mode === 'list' && Array.isArray(event.weeks.list)) {
        return event.weeks.list.map((item) => Number(item)).includes(week);
    }
    return true;
}

function getCurrentWeek(nowDate, semesterStartText) {
    const start = new Date(`${semesterStartText}T00:00:00+08:00`);
    if (Number.isNaN(start.getTime())) {
        return 1;
    }
    const diffDays = Math.floor((nowDate.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    return Math.max(1, Math.min(25, Math.floor(diffDays / 7) + 1));
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function toChinaLocalDate(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
}

function getChinaDateKey(date = new Date()) {
    const local = toChinaLocalDate(date);
    return `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
}

function getChinaDayOfWeek(date = new Date()) {
    const local = toChinaLocalDate(date);
    return local.getDay() === 0 ? 7 : local.getDay();
}

function getChinaMinutes(date = new Date()) {
    const local = toChinaLocalDate(date);
    return local.getHours() * 60 + local.getMinutes();
}

function createDateByChinaDateKeyAndMinutes(dateKey, minutes) {
    const dayStart = new Date(`${dateKey}T00:00:00+08:00`);
    if (Number.isNaN(dayStart.getTime())) {
        return null;
    }
    return new Date(dayStart.getTime() + minutes * 60 * 1000);
}

function shiftChinaDate(baseDate = new Date(), dayOffset = 0) {
    const baseKey = getChinaDateKey(baseDate);
    const baseNoon = new Date(`${baseKey}T12:00:00+08:00`);
    return new Date(baseNoon.getTime() + dayOffset * 24 * 60 * 60 * 1000);
}

function randomBetween(min, max) {
    if (max <= min) {
        return min;
    }
    return min + Math.floor(Math.random() * (max - min + 1));
}

function applyJitter(baseMs, ratio = 0.25) {
    const minFactor = Math.max(0.1, 1 - ratio);
    const maxFactor = 1 + ratio;
    return Math.floor(baseMs * (minFactor + Math.random() * (maxFactor - minFactor)));
}

function isRiskControlMessage(message) {
    const text = String(message || '').toLowerCase();
    const keywords = [
        '429',
        'too many requests',
        '请求过于频繁',
        '访问异常',
        '风控',
        'security verification',
        '账号异常',
        '操作过于频繁',
    ];
    return keywords.some((item) => text.includes(item));
}

function buildSuccessScanPlan(summary, inClassWindow, nowMs = Date.now()) {
    const activeAlertCount = Number(summary && summary.readyCount || 0) + Number(summary && summary.limitedCount || 0);

    let mode = 'idle';
    let intervalMs = WATCH_POLICY.sleepFallbackIntervalMs;

    if (activeAlertCount > 0) {
        mode = 'active_alert';
        intervalMs = randomBetween(WATCH_POLICY.activeHitMinIntervalMs, WATCH_POLICY.activeHitMaxIntervalMs);
    } else if (inClassWindow) {
        mode = 'class_window';
        intervalMs = randomBetween(WATCH_POLICY.scanningMinIntervalMs, WATCH_POLICY.scanningMaxIntervalMs);
    }

    intervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, Math.floor(intervalMs));
    return {
        mode,
        intervalMs,
        activeAlertCount,
        nextScanAt: new Date(nowMs + intervalMs).toISOString(),
    };
}

function buildErrorScanPlan(message, accountRecord, nowMs = Date.now()) {
    const previousErrorStreak = Number(accountRecord && accountRecord.watch_error_streak || 0);
    const errorStreak = previousErrorStreak + 1;
    const riskMode = isRiskControlMessage(message);

    let mode = 'error_backoff';
    let intervalMs = WATCH_POLICY.errorBackoffBaseMs;

    if (riskMode) {
        mode = 'risk_cooldown';
        intervalMs = applyJitter(WATCH_POLICY.riskCooldownMs, 0.2);
    } else {
        const backoff = WATCH_POLICY.errorBackoffBaseMs * Math.pow(2, Math.max(0, errorStreak - 1));
        intervalMs = applyJitter(Math.min(backoff, WATCH_POLICY.errorBackoffMaxMs), 0.25);
    }

    intervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, Math.floor(intervalMs));
    return {
        mode,
        errorStreak,
        intervalMs,
        nextScanAt: new Date(nowMs + intervalMs).toISOString(),
    };
}

function shouldSkipTimerScan(accountRecord, nowMs = Date.now()) {
    const nextScanAtMs = toTimestamp(accountRecord && accountRecord.watch_next_scan_at);
    if (!nextScanAtMs) {
        return false;
    }
    return nowMs < nextScanAtMs;
}

function resolveClassWindowLeadMinutes(scheduleRecord) {
    const reminder = scheduleRecord && scheduleRecord.reminder_settings && typeof scheduleRecord.reminder_settings === 'object'
        ? scheduleRecord.reminder_settings
        : {};
    const raw = reminder.leadMinutes !== undefined
        ? reminder.leadMinutes
        : reminder.lead_minutes;
    const fallback = WATCH_POLICY.classWindowLeadMinutes;
    if (!Number.isFinite(Number(raw))) {
        return fallback;
    }
    return clamp(raw, WATCH_POLICY.classWindowLeadMinMinutes, WATCH_POLICY.classWindowLeadMaxMinutes);
}

function summarizeWindow(windowItem) {
    if (!windowItem) {
        return null;
    }
    return {
        courseName: windowItem.courseName || '',
        startAt: windowItem.startAt || '',
        endAt: windowItem.endAt || '',
        classStartAt: windowItem.classStartAt || '',
        classEndAt: windowItem.classEndAt || '',
    };
}

function buildNextWatchDebugLog(record, entry) {
    const current = Array.isArray(record && record.watch_debug_log) ? record.watch_debug_log : [];
    return [entry, ...current].slice(0, WATCH_POLICY.debugLogLimit);
}

function shouldAppendWatchDebugLog(record, entry) {
    const current = Array.isArray(record && record.watch_debug_log) ? record.watch_debug_log : [];
    const previous = current[0];
    if (!previous) {
        return true;
    }
    const fields = ['stage', 'reason', 'nextScanAt', 'watchPhase', 'watchMode', 'scheduleId'];
    return fields.some((field) => String(previous[field] || '') !== String(entry[field] || ''));
}

function buildWatchDebugEntry(payload = {}) {
    return {
        scannedAt: payload.scannedAt || new Date().toISOString(),
        source: payload.source || '',
        stage: payload.stage || '',
        reason: payload.reason || '',
        watchPhase: payload.watchPhase || '',
        watchMode: payload.watchMode || '',
        scheduleId: payload.scheduleId || '',
        currentWindow: summarizeWindow(payload.currentWindow),
        nextWindow: summarizeWindow(payload.nextWindow),
        nextScanAt: payload.nextScanAt || '',
        nextIntervalMs: Number(payload.nextIntervalMs || 0),
        activeAlertCount: Number(payload.activeAlertCount || 0),
        signActivityCount: Number(payload.signActivityCount || 0),
        scannedCourseCount: Number(payload.scannedCourseCount || 0),
        detectedActiveIds: Array.isArray(payload.detectedActiveIds) ? payload.detectedActiveIds.slice(0, 8) : [],
        error: payload.error || '',
    };
}

function buildFallbackActivityDetail(activity) {
    const detail = {
        activeId: String(activity && activity.id ? activity.id : ''),
        signType: activity && activity.signType ? activity.signType : '',
        signTypeLabel: activity && activity.signTypeLabel ? activity.signTypeLabel : '签到',
        needPhoto: false,
        numberCount: 0,
        needCaptcha: false,
        signed: false,
        locationText: '',
        locationRange: '',
        unsupportedReason: '',
    };

    if (!detail.signType) {
        detail.unsupportedReason = '暂时无法识别签到类型';
    }

    if (!detail.unsupportedReason && activity && !activity.isSupported && activity.supportReason) {
        detail.unsupportedReason = activity.supportReason;
    }

    detail.canSign = !detail.signed && !detail.unsupportedReason;
    return detail;
}

function shouldFetchActivityDetailForAlert(activity, existingRecord = null) {
    if (!activity || !activity.status || !activity.isSupported) {
        return false;
    }
    if (!['normal', 'code', 'qrcode', 'location', 'pattern'].includes(activity.signType)) {
        return false;
    }
    if (!existingRecord || !existingRecord.is_active) {
        return true;
    }
    const lastDetectedAtMs = toTimestamp(existingRecord.last_detected_at || existingRecord.updated_at || existingRecord.first_detected_at);
    if (!lastDetectedAtMs) {
        return true;
    }
    return Date.now() - lastDetectedAtMs >= DETAIL_REFRESH_INTERVAL_MS;
}

function buildDetailFromExistingRecord(activity, existingRecord) {
    const signType = existingRecord && existingRecord.sign_type
        ? existingRecord.sign_type
        : (activity && activity.signType ? activity.signType : '');
    const signTypeLabel = existingRecord && existingRecord.sign_type_label
        ? existingRecord.sign_type_label
        : (activity && activity.signTypeLabel ? activity.signTypeLabel : '签到');
    const needCaptcha = !!(existingRecord && existingRecord.need_captcha);
    const unsupportedReason = existingRecord && existingRecord.unsupported_reason ? existingRecord.unsupported_reason : '';
    const signed = false;
    const canSign = !signed && !needCaptcha && !unsupportedReason;

    return {
        activeId: String(activity && activity.id ? activity.id : ''),
        signType,
        signTypeLabel,
        needPhoto: !!(existingRecord && existingRecord.need_photo),
        numberCount: 0,
        needCaptcha,
        signed,
        locationText: '',
        locationRange: '',
        unsupportedReason,
        canSign,
    };
}

async function getAccountRecord(openid) {
    const result = await db.collection(ACCOUNT_COLLECTION)
        .where({
            openid,
            platform: 'chaoxing',
        })
        .limit(1)
        .get();
    return result.data.length ? result.data[0] : null;
}

async function listBoundAccounts() {
    const result = await db.collection(ACCOUNT_COLLECTION)
        .where({ platform: 'chaoxing' })
        .limit(100)
        .get();
    return result.data || [];
}

async function listAlertRecords(openid) {
    const result = await db.collection(ALERT_COLLECTION)
        .where({
            openid,
            platform: 'chaoxing',
        })
        .limit(100)
        .get();
    return result.data || [];
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
    const result = await db.collection(SCHEDULE_COLLECTION)
        .where({ openid })
        .orderBy(orderField, 'desc')
        .limit(1)
        .get();
    const rows = Array.isArray(result.data) ? result.data : [];
    return rows[0] || null;
}

async function getLatestScheduleRecord(openid, scheduleCache) {
    if (scheduleCache && scheduleCache.has(openid)) {
        return scheduleCache.get(openid);
    }

    let latest = null;
    try {
        try {
            latest = await queryLatestScheduleRecord(openid, 'created_at');
        } catch (createdAtError) {
            console.warn('queryLatestScheduleRecord(created_at) failed:', openid, createdAtError);
        }

        if (!latest) {
            try {
                latest = await queryLatestScheduleRecord(openid, 'updated_at');
            } catch (updatedAtError) {
                console.warn('queryLatestScheduleRecord(updated_at) failed:', openid, updatedAtError);
            }
        }

        if (!latest) {
            const result = await db.collection(SCHEDULE_COLLECTION)
                .where({ openid })
                .limit(100)
                .get();
            latest = pickLatestScheduleRecord(result.data);
        }
    } catch (error) {
        console.warn('getLatestScheduleRecord failed:', openid, error);
    }

    if (latest) {
        console.log('[ScheduleWatch] using schedule:', JSON.stringify({
            openid,
            scheduleId: String(latest._id || ''),
            createdAt: toIsoText(latest.created_at),
            updatedAt: toIsoText(latest.updated_at),
            eventCount: Array.isArray(latest.events) ? latest.events.length : 0,
        }));
    }

    if (scheduleCache) {
        scheduleCache.set(openid, latest);
    }
    return latest;
}

function isInClassWindow(scheduleRecord, nowDate) {
    if (!scheduleRecord || !Array.isArray(scheduleRecord.events) || !scheduleRecord.events.length) {
        return false;
    }

    const leadMinutes = resolveClassWindowLeadMinutes(scheduleRecord);

    const reminder = scheduleRecord.reminder_settings || {};
    const semesterStart = String(reminder.semesterStart || WATCH_POLICY.defaultSemesterStart);
    const week = getCurrentWeek(nowDate, semesterStart);
    const dayOfWeek = nowDate.getDay() === 0 ? 7 : nowDate.getDay();
    const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

    for (const event of scheduleRecord.events) {
        if (Number(event.day_of_week) !== dayOfWeek) {
            continue;
        }
        if (!isEventInWeek(event, week)) {
            continue;
        }
        const time = event.time || {};
        const startMinutes = getPeriodBoundaryMinutes(time.period_start, 'start');
        const endMinutes = getPeriodBoundaryMinutes(time.period_end || time.period_start, 'end');
        if (startMinutes === null || endMinutes === null) {
            continue;
        }
        if (nowMinutes >= startMinutes - leadMinutes && nowMinutes <= endMinutes + WATCH_POLICY.classWindowTailMinutes) {
            return true;
        }
    }
    return false;
}

function toWindowStorageItem(windowItem) {
    return {
        courseName: windowItem.courseName || '',
        startAt: windowItem.startAt || '',
        endAt: windowItem.endAt || '',
        classStartAt: windowItem.classStartAt || '',
        classEndAt: windowItem.classEndAt || '',
    };
}

function buildCourseWindowsForDate(scheduleRecord, targetDate) {
    if (!scheduleRecord || !Array.isArray(scheduleRecord.events) || !scheduleRecord.events.length) {
        return [];
    }
    const reminder = scheduleRecord.reminder_settings || {};
    const leadMinutes = resolveClassWindowLeadMinutes(scheduleRecord);
    const semesterStart = String(reminder.semesterStart || WATCH_POLICY.defaultSemesterStart);
    const week = getCurrentWeek(targetDate, semesterStart);
    const dayOfWeek = getChinaDayOfWeek(targetDate);
    const dateKey = getChinaDateKey(targetDate);
    const windows = [];

    for (const event of scheduleRecord.events) {
        if (Number(event.day_of_week) !== dayOfWeek) {
            continue;
        }
        if (!isEventInWeek(event, week)) {
            continue;
        }
        const time = event.time || {};
        const classStartMinutes = getPeriodBoundaryMinutes(time.period_start, 'start');
        const classEndMinutes = getPeriodBoundaryMinutes(time.period_end || time.period_start, 'end');
        if (classStartMinutes === null || classEndMinutes === null) {
            continue;
        }
        const windowStartMinutes = classStartMinutes - leadMinutes;
        const windowEndMinutes = classEndMinutes + WATCH_POLICY.classWindowTailMinutes;
        const windowStartDate = createDateByChinaDateKeyAndMinutes(dateKey, windowStartMinutes);
        const windowEndDate = createDateByChinaDateKeyAndMinutes(dateKey, windowEndMinutes);
        const classStartDate = createDateByChinaDateKeyAndMinutes(dateKey, classStartMinutes);
        const classEndDate = createDateByChinaDateKeyAndMinutes(dateKey, classEndMinutes);
        if (!windowStartDate || !windowEndDate || !classStartDate || !classEndDate) {
            continue;
        }
        windows.push({
            courseName: String(event.course_name || ''),
            startMs: windowStartDate.getTime(),
            endMs: windowEndDate.getTime(),
            classStartMs: classStartDate.getTime(),
            classEndMs: classEndDate.getTime(),
            startAt: windowStartDate.toISOString(),
            endAt: windowEndDate.toISOString(),
            classStartAt: classStartDate.toISOString(),
            classEndAt: classEndDate.toISOString(),
        });
    }

    windows.sort((left, right) => left.startMs - right.startMs);
    if (!windows.length) {
        return [];
    }

    const merged = [windows[0]];
    const mergeGapMs = WATCH_POLICY.mergeGapMinutes * 60 * 1000;
    for (let i = 1; i < windows.length; i += 1) {
        const current = windows[i];
        const previous = merged[merged.length - 1];
        if (current.startMs <= previous.endMs + mergeGapMs) {
            previous.endMs = Math.max(previous.endMs, current.endMs);
            previous.classEndMs = Math.max(previous.classEndMs, current.classEndMs);
            previous.endAt = new Date(previous.endMs).toISOString();
            previous.classEndAt = new Date(previous.classEndMs).toISOString();
            if (current.courseName && !previous.courseName.includes(current.courseName)) {
                previous.courseName = previous.courseName
                    ? `${previous.courseName} / ${current.courseName}`
                    : current.courseName;
            }
            continue;
        }
        merged.push(current);
    }
    return merged;
}

function resolveWindowContext(windows, nowMs) {
    if (!Array.isArray(windows) || !windows.length) {
        return {
            currentWindow: null,
            currentWindowIndex: -1,
            nextWindow: null,
            nextWindowIndex: -1,
        };
    }

    for (let i = 0; i < windows.length; i += 1) {
        const item = windows[i];
        if (nowMs >= item.startMs && nowMs <= item.endMs) {
            return {
                currentWindow: item,
                currentWindowIndex: i,
                nextWindow: i + 1 < windows.length ? windows[i + 1] : null,
                nextWindowIndex: i + 1 < windows.length ? i + 1 : -1,
            };
        }
    }

    for (let i = 0; i < windows.length; i += 1) {
        if (nowMs < windows[i].startMs) {
            return {
                currentWindow: null,
                currentWindowIndex: -1,
                nextWindow: windows[i],
                nextWindowIndex: i,
            };
        }
    }

    return {
        currentWindow: null,
        currentWindowIndex: -1,
        nextWindow: null,
        nextWindowIndex: -1,
    };
}

function findNextWindowAcrossDays(scheduleRecord, nowDate) {
    const nowMs = nowDate.getTime();
    for (let offset = 0; offset <= WATCH_POLICY.maxLookupDays; offset += 1) {
        const targetDate = shiftChinaDate(nowDate, offset);
        const windows = buildCourseWindowsForDate(scheduleRecord, targetDate);
        if (!windows.length) {
            continue;
        }
        for (const windowItem of windows) {
            if (windowItem.startMs > nowMs) {
                return windowItem;
            }
        }
    }
    return null;
}

function isValidWatchPhase(phase) {
    return ['sleep', 'preheat', 'scanning', 'active_hit', 'post_sign'].includes(String(phase || ''));
}

function pickPhaseIntervalMs(phase) {
    if (phase === 'active_hit') {
        return randomBetween(WATCH_POLICY.activeHitMinIntervalMs, WATCH_POLICY.activeHitMaxIntervalMs);
    }
    if (phase === 'post_sign') {
        return randomBetween(WATCH_POLICY.postSignMinIntervalMs, WATCH_POLICY.postSignMaxIntervalMs);
    }
    if (phase === 'preheat') {
        return randomBetween(WATCH_POLICY.preheatMinIntervalMs, WATCH_POLICY.preheatMaxIntervalMs);
    }
    return randomBetween(WATCH_POLICY.scanningMinIntervalMs, WATCH_POLICY.scanningMaxIntervalMs);
}

function toClientAccount(record) {
    if (!record) {
        return null;
    }
    return {
        accountUid: record.account_uid || '',
        displayName: record.display_name || '',
        avatarUrl: record.avatar_url || '',
        phoneMasked: record.phone_masked || '',
        lastSignPhotoFileId: record.last_sign_photo_file_id || '',
        lastSignPhotoName: record.last_sign_photo_name || '',
        lastSignPhotoUpdatedAt: record.last_sign_photo_updated_at || '',
        lastWatchScanAt: record.last_watch_scan_at || '',
        lastWatchDurationMs: Number(record.last_watch_duration_ms || 0),
        lastWatchStatus: record.last_watch_status || '',
        lastWatchError: record.last_watch_error || '',
        lastWatchSource: record.last_watch_source || '',
        nextWatchScanAt: record.watch_next_scan_at || '',
        nextWatchIntervalMs: Number(record.watch_next_interval_ms || 0),
        watchMode: record.watch_mode || '',
        watchErrorStreak: Number(record.watch_error_streak || 0),
        watchLastActiveAlertCount: Number(record.watch_last_active_alert_count || 0),
        watchPhase: record.watch_phase || 'sleep',
        watchTodayKey: record.watch_today_key || '',
        watchTodayWindows: Array.isArray(record.watch_today_windows) ? record.watch_today_windows : [],
        watchCurrentWindowIndex: Number(record.watch_current_window_index || -1),
        watchLastActiveId: record.watch_last_active_id || '',
        watchLastSignedAt: record.watch_last_signed_at || '',
        watchCooldownUntil: record.watch_cooldown_until || '',
        watchDebugLog: Array.isArray(record.watch_debug_log) ? record.watch_debug_log.slice(0, 20) : [],
        autoSignEnabled: !!record.auto_sign_enabled,
        autoSignTypes: Array.isArray(record.auto_sign_types) ? record.auto_sign_types : ['normal', 'photo', 'pattern', 'code', 'location'],
        defaultLocation: record.default_location || null,
        autoSignLog: Array.isArray(record.auto_sign_log) ? record.auto_sign_log.slice(0, 5) : [],
    };
}

function toClientAlert(record) {
    return {
        id: record._id,
        activeId: record.active_id || '',
        courseId: record.course_id || '',
        classId: record.class_id || '',
        cpi: record.cpi || '',
        courseName: record.course_name || '',
        activityName: record.activity_name || '',
        signType: record.sign_type || '',
        signTypeLabel: record.sign_type_label || '',
        helperText: record.helper_text || '',
        status: record.status || 'ready',
        canOpen: record.can_open !== false,
        isActive: !!record.is_active,
        isRead: !!record.is_read,
        detectedAt: record.last_detected_at || record.updated_at || '',
        startTime: record.start_time || '',
        needPhoto: !!record.need_photo,
        needCaptcha: !!record.need_captcha,
        unsupportedReason: record.unsupported_reason || '',
    };
}

async function upsertAccount(openid, patch, existingRecord) {
    const payload = {
        ...patch,
        openid,
        platform: 'chaoxing',
    };
    if (existingRecord && existingRecord._id) {
        await db.collection(ACCOUNT_COLLECTION).doc(existingRecord._id).update({
            data: payload,
        });
        return {
            ...existingRecord,
            ...payload,
        };
    }
    const addResult = await db.collection(ACCOUNT_COLLECTION).add({
        data: payload,
    });
    return {
        _id: addResult._id,
        ...payload,
    };
}

async function persistSession(record, session) {
    if (!record || !record._id) {
        return;
    }
    await db.collection(ACCOUNT_COLLECTION).doc(record._id).update({
        data: {
            ...serializeSession(session),
            updated_at: new Date().toISOString(),
        },
    });
}

async function updateAccountMeta(record, patch) {
    if (!record || !record._id) {
        return;
    }
    await db.collection(ACCOUNT_COLLECTION).doc(record._id).update({
        data: patch,
    });
    Object.assign(record, patch);
}

async function withBoundAccount(openid, handler) {
    const record = await getAccountRecord(openid);
    if (!record) {
        throw appError('AUTH_REQUIRED', '请先绑定超星账号');
    }
    const session = createSession(record);
    try {
        return await handler(record, session);
    } finally {
        await persistSession(record, session);
    }
}

async function deleteCloudFile(fileId) {
    if (!fileId) {
        return;
    }
    try {
        await cloud.deleteFile({
            fileList: [fileId],
        });
    } catch (error) {
        console.warn('deleteCloudFile failed:', error);
    }
}

function toBuffer(fileContent) {
    if (Buffer.isBuffer(fileContent)) {
        return fileContent;
    }
    if (fileContent instanceof ArrayBuffer) {
        return Buffer.from(fileContent);
    }
    if (ArrayBuffer.isView(fileContent)) {
        return Buffer.from(fileContent.buffer, fileContent.byteOffset, fileContent.byteLength);
    }
    return Buffer.from(fileContent || []);
}

function getStatusAndHelper(activity, detail) {
    let signType = activity.signType || '';
    let signTypeLabel = activity.signTypeLabel || detail.signTypeLabel || '签到';
    let status = 'ready';
    let helperText = '已检测到可处理签到，进入后即可继续操作。';
    let canOpen = true;

    if (signType === 'normal' && detail.needPhoto) {
        signType = 'photo';
        signTypeLabel = '拍照签到';
        helperText = '已检测到拍照签到，可以直接复用最近一张签到图。';
    } else if (signType === 'code') {
        helperText = '已检测到签到码签到，进入后输入签到码即可。';
    } else if (signType === 'qrcode') {
        helperText = '已检测到二维码签到，进入后扫码即可。';
    } else if (signType === 'normal') {
        helperText = '已检测到普通签到，进入后可直接提交。';
    } else if (signType === 'location') {
        helperText = '已检测到定位签到，可使用预设或当前位置签到。';
    } else if (signType === 'pattern') {
        helperText = '已检测到手势签到，系统将自动尝试穷举破解。';
    }

    if (detail.needCaptcha) {
        status = 'limited';
        helperText = '这次签到需要滑块验证，当前小程序暂不支持。';
        canOpen = false;
    } else if (detail.unsupportedReason) {
        status = 'limited';
        helperText = detail.unsupportedReason;
        canOpen = false;
    }

    return {
        signType,
        signTypeLabel,
        status,
        helperText,
        canOpen,
    };
}

function buildAlertPatch(openid, accountRecord, course, activity, detail, existingRecord) {
    const now = new Date().toISOString();
    const meta = getStatusAndHelper(activity, detail);
    return {
        openid,
        platform: 'chaoxing',
        account_uid: String(accountRecord.account_uid || ''),
        active_id: activity.id,
        course_id: course.courseId,
        class_id: course.classId,
        cpi: course.cpi,
        course_name: course.name,
        activity_name: activity.name,
        sign_type: meta.signType,
        sign_type_label: meta.signTypeLabel,
        helper_text: meta.helperText,
        status: meta.status,
        can_open: meta.canOpen,
        need_photo: !!detail.needPhoto,
        need_captcha: !!detail.needCaptcha,
        unsupported_reason: detail.unsupportedReason || '',
        start_time: toIsoText(activity.startTime || ''),
        first_detected_at: existingRecord && existingRecord.first_detected_at ? existingRecord.first_detected_at : now,
        last_detected_at: now,
        updated_at: now,
        is_read: existingRecord ? !!existingRecord.is_read : false,
        read_at: existingRecord && existingRecord.read_at ? existingRecord.read_at : '',
        is_active: true,
    };
}

async function upsertAlertRecord(patch, existingRecord) {
    if (existingRecord && existingRecord._id) {
        await db.collection(ALERT_COLLECTION).doc(existingRecord._id).update({
            data: patch,
        });
        return {
            ...existingRecord,
            ...patch,
        };
    }
    const addResult = await db.collection(ALERT_COLLECTION).add({
        data: patch,
    });
    return {
        _id: addResult._id,
        ...patch,
    };
}

async function closeAlertRecord(record, status, helperText) {
    if (!record || !record._id) {
        return;
    }
    await db.collection(ALERT_COLLECTION).doc(record._id).update({
        data: {
            is_active: false,
            status,
            helper_text: helperText,
            updated_at: new Date().toISOString(),
        },
    });
}

async function scanAndSyncAlertsForAccount(accountRecord, session) {
    const existingRecords = await listAlertRecords(accountRecord.openid);
    const existingMap = new Map(existingRecords.map((item) => [String(item.active_id), item]));
    const seenActiveIds = new Set();
    const activeAlerts = [];
    const courses = await fetchCourses(session);

    for (const course of courses) {
        const activities = await fetchActivities(session, {
            courseId: course.courseId,
            classId: course.classId,
            cpi: course.cpi,
            accountUid: String(accountRecord.account_uid || ''),
        });

        const signActivities = activities.filter((item) =>
            ['signIn', 'signOut', 'scheduledSignIn'].includes(item.activeType)
        );

        for (const activity of signActivities) {
            seenActiveIds.add(String(activity.id));
            const existingRecord = existingMap.get(String(activity.id));

            if (!activity.status) {
                if (existingRecord && existingRecord.is_active) {
                    await closeAlertRecord(existingRecord, 'closed', '该签到已经结束。');
                }
                continue;
            }

            let detail;
            try {
                detail = await getActivityDetail(session, {
                    activeId: activity.id,
                    signType: activity.signType,
                });
            } catch (error) {
                if (error && error.code === 'SESSION_EXPIRED') {
                    throw error;
                }
                console.warn('getActivityDetail failed:', activity.id, error);
                continue;
            }

            if (detail.signed) {
                if (existingRecord && existingRecord.is_active) {
                    await closeAlertRecord(existingRecord, 'signed', '当前账号已经完成这次签到。');
                }
                continue;
            }

            const patch = buildAlertPatch(accountRecord.openid, accountRecord, course, activity, detail, existingRecord);
            const savedRecord = await upsertAlertRecord(patch, existingRecord);
            activeAlerts.push(toClientAlert(savedRecord));
        }
    }

    for (const record of existingRecords) {
        if (record.is_active && !seenActiveIds.has(String(record.active_id))) {
            await closeAlertRecord(record, 'closed', '该签到已经结束或当前不再可见。');
        }
    }

    return buildAlertSummary(sortAlerts(activeAlerts));
}

async function scanAndSyncAlertsForAccountFast(accountRecord, session) {
    const existingRecords = await listAlertRecords(accountRecord.openid);
    const existingMap = new Map(existingRecords.map((item) => [String(item.active_id), item]));
    const seenActiveIds = new Set();
    const activeAlerts = [];
    const courses = await fetchCourses(session);
    let signActivityCount = 0;

    const courseScans = await mapWithConcurrency(courses, COURSE_SCAN_CONCURRENCY, async (course) => {
        try {
            const activities = await fetchActivities(session, {
                courseId: course.courseId,
                classId: course.classId,
                cpi: course.cpi,
                accountUid: String(accountRecord.account_uid || ''),
            });

            return {
                course,
                activities: activities.filter((item) =>
                    ['signIn', 'signOut', 'scheduledSignIn'].includes(item.activeType)
                ),
            };
        } catch (error) {
            if (error && error.code === 'SESSION_EXPIRED') {
                throw error;
            }
            console.warn('fetchActivities failed:', course.courseId, error);
            return {
                course,
                activities: [],
            };
        }
    });

    for (const courseScan of courseScans) {
        const course = courseScan.course;
        const signActivities = Array.isArray(courseScan.activities) ? courseScan.activities : [];
        signActivityCount += signActivities.length;

        for (const activity of signActivities) {
            seenActiveIds.add(String(activity.id));
            const existingRecord = existingMap.get(String(activity.id));

            if (!activity.status) {
                if (existingRecord && existingRecord.is_active) {
                    await closeAlertRecord(existingRecord, 'closed', '该签到已经结束。');
                }
                continue;
            }

            let detail = existingRecord && existingRecord.is_active
                ? buildDetailFromExistingRecord(activity, existingRecord)
                : buildFallbackActivityDetail(activity);
            if (shouldFetchActivityDetailForAlert(activity, existingRecord)) {
                try {
                    detail = await getActivityDetail(session, {
                        activeId: activity.id,
                        signType: activity.signType,
                    });
                } catch (error) {
                    if (error && error.code === 'SESSION_EXPIRED') {
                        throw error;
                    }
                    console.warn('getActivityDetail failed:', activity.id, error);
                }
            }

            if (detail.signed) {
                if (existingRecord && existingRecord.is_active) {
                    await closeAlertRecord(existingRecord, 'signed', '当前账号已经完成这次签到。');
                }
                continue;
            }

            // ===== 自动签到插入点 =====
            const isNewActivity = !existingRecord || !existingRecord.is_active;
            if (isNewActivity && detail.canSign && accountRecord.auto_sign_enabled) {
                const autoResult = await tryAutoSign(session, accountRecord, course, activity, detail);
                if (autoResult) {
                    // 自动签到成功，不再写通知
                    continue;
                }
            }

            const patch = buildAlertPatch(accountRecord.openid, accountRecord, course, activity, detail, existingRecord);
            const savedRecord = await upsertAlertRecord(patch, existingRecord);
            activeAlerts.push(toClientAlert(savedRecord));
        }
    }

    for (const record of existingRecords) {
        if (record.is_active && !seenActiveIds.has(String(record.active_id))) {
            await closeAlertRecord(record, 'closed', '该签到已经结束或当前不再可见。');
        }
    }

    const latestRecords = await listAlertRecords(accountRecord.openid);
    return {
        ...buildAlertSummary(sortAlerts(activeAlerts), buildRecentAlertHistory(latestRecords)),
        scannedCourseCount: courses.length,
        signActivityCount,
        detectedActiveIds: Array.from(seenActiveIds).slice(0, 8),
    };
}

async function getOpenAlertSummary(openid) {
    const records = await listAlertRecords(openid);
    const alerts = sortAlerts(
        records
            .filter((item) => item.is_active)
            .map((item) => toClientAlert(item))
    );
    const historyAlerts = buildRecentAlertHistory(records);
    return buildAlertSummary(alerts, historyAlerts);
}

async function markSignNotificationsRead(openid, activeId = '') {
    const records = await listAlertRecords(openid);
    const targets = records.filter((item) => {
        if (!item.is_active || item.is_read) {
            return false;
        }
        if (activeId) {
            return String(item.active_id) === String(activeId);
        }
        return true;
    });

    const now = new Date().toISOString();
    for (const item of targets) {
        await db.collection(ALERT_COLLECTION).doc(item._id).update({
            data: {
                is_read: true,
                read_at: now,
                updated_at: now,
            },
        });
    }
    return getOpenAlertSummary(openid);
}

async function resolveAlertAfterSign(openid, activeId, helperText = '当前账号已经完成这次签到。') {
    const records = await listAlertRecords(openid);
    const target = records.find((item) => String(item.active_id) === String(activeId));
    if (!target) {
        return;
    }
    await db.collection(ALERT_COLLECTION).doc(target._id).update({
        data: {
            is_active: false,
            is_read: true,
            read_at: new Date().toISOString(),
            status: 'signed',
            helper_text: helperText,
            updated_at: new Date().toISOString(),
        },
    });
}

const AUTO_SIGN_LOG_MAX = 10;

async function appendAutoSignLog(accountRecord, logEntry) {
    if (!accountRecord || !accountRecord._id) {
        return;
    }
    const existingLog = Array.isArray(accountRecord.auto_sign_log) ? accountRecord.auto_sign_log : [];
    const updatedLog = [logEntry, ...existingLog].slice(0, AUTO_SIGN_LOG_MAX);
    await db.collection(ACCOUNT_COLLECTION).doc(accountRecord._id).update({
        data: {
            auto_sign_log: updatedLog,
            updated_at: new Date().toISOString(),
        },
    });
    accountRecord.auto_sign_log = updatedLog;
}

// ===== 手势签到穷举引擎 =====

// 3×3 宫格相邻关系表。如果从点 A 到点 B 必须经过中间点 C，则记录在 MIDPOINTS 中。
// 点编号 1-9（左上到右下）
const MIDPOINTS = {
    '1-3': 2, '3-1': 2,
    '1-7': 4, '7-1': 4,
    '1-9': 5, '9-1': 5,
    '2-8': 5, '8-2': 5,
    '3-7': 5, '7-3': 5,
    '3-9': 6, '9-3': 6,
    '4-6': 5, '6-4': 5,
    '7-9': 8, '9-7': 8,
};

function generateAllPatterns() {
    const results = [];

    function dfs(path, visited) {
        if (path.length >= 4) {
            results.push(path.join(''));
        }
        if (path.length >= 9) {
            return;
        }
        for (let next = 1; next <= 9; next++) {
            if (visited[next]) {
                continue;
            }
            if (path.length > 0) {
                const last = path[path.length - 1];
                const midKey = `${last}-${next}`;
                const mid = MIDPOINTS[midKey];
                // 如果两点之间有中间点，且中间点未被访问，则路径无效（不能跳过）
                if (mid && !visited[mid]) {
                    continue;
                }
            }
            visited[next] = true;
            path.push(next);
            dfs(path, visited);
            path.pop();
            visited[next] = false;
        }
    }

    const visited = {};
    for (let start = 1; start <= 9; start++) {
        visited[start] = true;
        dfs([start], visited);
        visited[start] = false;
    }

    return results;
}

// 高频手势优先列表（常见的 L、Z、N、C、U 等简单图形）
const HIGH_PRIORITY_PATTERNS = [
    '1254', '1258', '1256', '1478', '1236', '1456', '1357', '1369',
    '1235', '1259', '1475', '1597', '1234', '1247', '1593', '1698',
    '1245', '1452', '1596', '3214', '3216', '3578', '3698', '3571',
    '4561', '4563', '4789', '4123', '4567', '7415', '7896', '7856',
    '7894', '7852', '7896', '9517', '9631', '9874', '9876', '9654',
    '12369', '14789', '36987', '32147', '12587', '14523', '74123',
    '78963', '98741', '96321', '25896', '25874', '15963', '35789',
    '123654', '147896', '123456', '987654', '741258', '369258',
    '159357', '123698', '789456', '456123', '654321', '987456123',
    '123456789', '147258369', '159', '357', '951', '753',
    '1379', '3197', '7193', '9371',
];

let _cachedPatterns = null;

function getOrderedPatterns() {
    if (_cachedPatterns) {
        return _cachedPatterns;
    }
    const allPatterns = generateAllPatterns();
    const prioritySet = new Set(HIGH_PRIORITY_PATTERNS);
    const prioritized = HIGH_PRIORITY_PATTERNS.filter((p) => allPatterns.includes(p));
    const remaining = allPatterns.filter((p) => !prioritySet.has(p));
    // 剩余的按长度升序排列（短手势优先）
    remaining.sort((a, b) => a.length - b.length);
    _cachedPatterns = [...prioritized, ...remaining];
    return _cachedPatterns;
}

const PATTERN_BRUTE_FORCE_TIMEOUT_MS = 12000;
const PATTERN_BATCH_SIZE = 5;
const PATTERN_BATCH_DELAY_MS = 100;

async function bruteForcePatternSign(session, { courseId, activeId, accountUid, accountName }) {
    const patterns = getOrderedPatterns();
    const startTime = Date.now();
    let attempts = 0;

    for (let i = 0; i < patterns.length; i += PATTERN_BATCH_SIZE) {
        if (Date.now() - startTime > PATTERN_BRUTE_FORCE_TIMEOUT_MS) {
            console.warn('[PatternSign] 穷举超时，已尝试', attempts, '种手势');
            return null;
        }

        const batch = patterns.slice(i, i + PATTERN_BATCH_SIZE);
        const results = await Promise.all(
            batch.map((code) => tryCheckSignCode(session, activeId, code).then((ok) => ({ code, ok })))
        );

        attempts += batch.length;

        const hit = results.find((r) => r.ok);
        if (hit) {
            console.log('[PatternSign] 命中手势:', hit.code, '尝试次数:', attempts);
            const signResult = await codeSign(session, {
                courseId,
                activeId,
                accountUid,
                accountName,
                signCode: hit.code,
            });
            return signResult;
        }

        // 延迟一下避免触发频控
        if (i + PATTERN_BATCH_SIZE < patterns.length) {
            await new Promise((resolve) => setTimeout(resolve, PATTERN_BATCH_DELAY_MS));
        }
    }

    console.warn('[PatternSign] 全部穷举完毕仍未命中，共尝试', attempts, '种手势');
    return null;
}

async function tryAutoSign(session, accountRecord, course, activity, detail) {
    if (!accountRecord.auto_sign_enabled) {
        return null;
    }

    const allowedTypes = Array.isArray(accountRecord.auto_sign_types)
        ? accountRecord.auto_sign_types
        : ['normal', 'photo', 'code', 'pattern', 'location'];

    const effectiveType = (detail.signType === 'normal' && detail.needPhoto) ? 'photo' : detail.signType;

    if (!allowedTypes.includes(effectiveType)) {
        return null;
    }

    if (detail.needCaptcha || detail.unsupportedReason) {
        return null;
    }

    const logEntry = {
        activeId: String(activity.id),
        courseName: course.name || '',
        activityName: activity.name || '',
        signType: effectiveType,
        attemptedAt: new Date().toISOString(),
        status: 'pending',
        message: '',
    };

    try {
        let result;
        if (effectiveType === 'normal') {
            // 普通签到：直接调用 normalSign
            result = await normalSign(session, {
                courseId: course.courseId,
                activeId: String(activity.id),
                accountUid: String(accountRecord.account_uid || ''),
                accountName: accountRecord.display_name || '',
            });
        } else if (effectiveType === 'code') {
            // 签到码类型：三级降级策略
            // 第1步：尝试免码绕过（normalSign 不传 signCode）
            let bypassSuccess = false;
            try {
                result = await normalSign(session, {
                    courseId: course.courseId,
                    activeId: String(activity.id),
                    accountUid: String(accountRecord.account_uid || ''),
                    accountName: accountRecord.display_name || '',
                });
                if (result && (result.status === 'success' || result.status === 'already_signed')) {
                    bypassSuccess = true;
                    console.log('[AutoSign] 签到码免码绕过成功:', course.name, activity.name);
                }
            } catch (bypassError) {
                // 免码被拒绝（如超星返回 SIGN_FAILED），属于正常降级
                console.log('[AutoSign] 免码绕过失败，降级到共享池:', course.name, bypassError && bypassError.message);
            }

            // 第2步：免码失败，尝试共享池
            if (!bypassSuccess) {
                try {
                    const poolCodeRecord = await db.collection(SIGN_CODE_COLLECTION)
                        .where({ active_id: String(activity.id) })
                        .limit(1)
                        .get();
                    if (poolCodeRecord.data && poolCodeRecord.data.length > 0) {
                        const poolCode = poolCodeRecord.data[0].sign_code;
                        console.log(`[AutoSign] 从共享池获取到签到码: ${poolCode}`);
                        result = await codeSign(session, {
                            courseId: course.courseId,
                            activeId: String(activity.id),
                            accountUid: String(accountRecord.account_uid || ''),
                            accountName: accountRecord.display_name || '',
                            signCode: poolCode,
                        });
                    } else {
                        // 第3步：共享池也没有，降级为通知
                        logEntry.status = 'skipped';
                        logEntry.message = '签到码暂无来源（免码失败、共享池为空），等待同学贡献';
                        await appendAutoSignLog(accountRecord, logEntry);
                        return null;
                    }
                } catch (poolError) {
                    console.warn('[AutoSign] 共享池读取或签到异常', poolError);
                    logEntry.status = 'failed';
                    logEntry.message = poolError && poolError.message ? poolError.message : '共享池签到异常';
                    await appendAutoSignLog(accountRecord, logEntry);
                    return null;
                }
            }
        } else if (effectiveType === 'photo') {
            if (!accountRecord.last_sign_photo_file_id) {
                logEntry.status = 'skipped';
                logEntry.message = '未上传签到图片，无法自动拍照签到';
                await appendAutoSignLog(accountRecord, logEntry);
                return null;
            }
            const download = await cloud.downloadFile({
                fileID: accountRecord.last_sign_photo_file_id,
            });
            result = await photoSign(session, {
                courseId: course.courseId,
                activeId: String(activity.id),
                accountUid: String(accountRecord.account_uid || ''),
                accountName: accountRecord.display_name || '',
                fileBuffer: toBuffer(download.fileContent),
                fileName: accountRecord.last_sign_photo_name || 'sign.jpg',
            });
        } else if (effectiveType === 'location') {
            if (!accountRecord.default_location || !accountRecord.default_location.latitude) {
                logEntry.status = 'skipped';
                logEntry.message = '未设置默认确切位置，取消自动定位签到';
                await appendAutoSignLog(accountRecord, logEntry);
                return null;
            }
            result = await locationSign(session, {
                courseId: course.courseId,
                activeId: String(activity.id),
                accountUid: String(accountRecord.account_uid || ''),
                accountName: accountRecord.display_name || '',
                address: accountRecord.default_location.address,
                latitude: String(accountRecord.default_location.latitude),
                longitude: String(accountRecord.default_location.longitude),
            });
        } else if (effectiveType === 'pattern') {
            result = await bruteForcePatternSign(session, {
                courseId: course.courseId,
                activeId: String(activity.id),
                accountUid: String(accountRecord.account_uid || ''),
                accountName: accountRecord.display_name || '',
            });
            if (!result) {
                logEntry.status = 'failed';
                logEntry.message = '手势穷举未命中或超时';
                await appendAutoSignLog(accountRecord, logEntry);
                return null;
            }
        } else {
            return null;
        }

        logEntry.status = result && result.status === 'already_signed' ? 'already_signed' : 'success';
        logEntry.message = result && result.message ? result.message : '签到成功';
        await appendAutoSignLog(accountRecord, logEntry);
        accountRecord.watch_last_signed_at = new Date().toISOString();
        accountRecord.watch_last_active_id = String(activity.id);
        await resolveAlertAfterSign(accountRecord.openid, String(activity.id), '已由系统自动完成签到。');
        console.log('[AutoSign] 自动签到成功:', course.name, activity.name, effectiveType);
        return result;
    } catch (error) {
        logEntry.status = 'failed';
        logEntry.message = error && error.message ? error.message : '自动签到失败';
        await appendAutoSignLog(accountRecord, logEntry);
        console.warn('[AutoSign] 自动签到失败，将降级为通知:', course.name, activity.name, error);
        return null;
    }
}

async function watchAllSigns() {
    const accounts = await listBoundAccounts();
    let processed = 0;
    let refreshed = 0;
    const errors = [];

    for (const accountRecord of accounts) {
        processed += 1;
        const session = createSession(accountRecord);
        try {
            await scanAndSyncAlertsForAccountFast(accountRecord, session);
            await persistSession(accountRecord, session);
            refreshed += 1;
        } catch (error) {
            errors.push({
                openid: accountRecord.openid,
                message: error && error.message ? error.message : '巡检失败',
            });
            try {
                await persistSession(accountRecord, session);
            } catch (persistError) {
                console.warn('persistSession failed in watchAllSigns:', persistError);
            }
        }
    }

    return {
        processed,
        refreshed,
        errors,
        scannedAt: new Date().toISOString(),
    };
}

async function watchAllSignsFast(source = 'manual') {
    const startedAt = Date.now();
    const accounts = await listBoundAccounts();
    const scheduleCache = new Map();
    let processed = 0;
    let refreshed = 0;
    let skipped = 0;
    const errors = [];

    await mapWithConcurrency(accounts, ACCOUNT_SCAN_CONCURRENCY, async (accountRecord) => {
        processed += 1;
        const nowDate = new Date();
        const nowMs = nowDate.getTime();
        const scannedAt = new Date().toISOString();
        const cooldownUntilMs = toTimestamp(accountRecord.watch_cooldown_until);
        const skipCooldownLogEntry = buildWatchDebugEntry({
            scannedAt,
            source,
            stage: 'skip',
            reason: 'cooldown',
            watchPhase: String(accountRecord.watch_phase || 'sleep'),
            watchMode: String(accountRecord.watch_mode || 'sleep'),
            nextScanAt: accountRecord.watch_next_scan_at || '',
            nextIntervalMs: Number(accountRecord.watch_next_interval_ms || 0),
        });

        if (source === 'timer' && cooldownUntilMs && nowMs < cooldownUntilMs) {
            if (shouldAppendWatchDebugLog(accountRecord, skipCooldownLogEntry)) {
                try {
                    await updateAccountMeta(accountRecord, {
                        watch_debug_log: buildNextWatchDebugLog(accountRecord, skipCooldownLogEntry),
                    });
                } catch (logError) {
                    console.warn('append watch_debug_log failed in cooldown skip branch:', logError);
                }
            }
            skipped += 1;
            return;
        }

        const skipNextScanLogEntry = buildWatchDebugEntry({
            scannedAt,
            source,
            stage: 'skip',
            reason: 'next_scan_not_due',
            watchPhase: String(accountRecord.watch_phase || 'sleep'),
            watchMode: String(accountRecord.watch_mode || 'sleep'),
            nextScanAt: accountRecord.watch_next_scan_at || '',
            nextIntervalMs: Number(accountRecord.watch_next_interval_ms || 0),
        });

        if (source === 'timer' && shouldSkipTimerScan(accountRecord, nowMs)) {
            if (shouldAppendWatchDebugLog(accountRecord, skipNextScanLogEntry)) {
                try {
                    await updateAccountMeta(accountRecord, {
                        watch_debug_log: buildNextWatchDebugLog(accountRecord, skipNextScanLogEntry),
                    });
                } catch (logError) {
                    console.warn('append watch_debug_log failed in next_scan skip branch:', logError);
                }
            }
            skipped += 1;
            return;
        }

        const scheduleRecord = await getLatestScheduleRecord(accountRecord.openid, scheduleCache);
        const scheduleId = String(scheduleRecord && scheduleRecord._id || '');
        const todayKey = getChinaDateKey(nowDate);
        const todayWindows = buildCourseWindowsForDate(scheduleRecord, nowDate);
        const windowContext = resolveWindowContext(todayWindows, nowMs);
        const currentWindow = windowContext.currentWindow;
        const nextWindow = windowContext.nextWindow || findNextWindowAcrossDays(scheduleRecord, nowDate);

        if (source === 'timer' && !currentWindow) {
            const nextScanAt = nextWindow ? nextWindow.startAt : new Date(nowMs + WATCH_POLICY.sleepFallbackIntervalMs).toISOString();
            const nextIntervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, toTimestamp(nextScanAt) - nowMs);
            const sleepLogEntry = buildWatchDebugEntry({
                scannedAt,
                source,
                stage: 'sleep',
                reason: todayWindows.length ? 'outside_class_window' : 'no_class_window_today',
                watchPhase: 'sleep',
                watchMode: 'sleep',
                scheduleId,
                nextWindow,
                nextScanAt,
                nextIntervalMs,
            });
            try {
                await updateAccountMeta(accountRecord, {
                    watch_phase: 'sleep',
                    watch_mode: 'sleep',
                    watch_next_scan_at: nextScanAt,
                    watch_next_interval_ms: nextIntervalMs,
                    watch_today_key: todayKey,
                    watch_today_windows: todayWindows.map(toWindowStorageItem),
                    watch_current_window_index: -1,
                    watch_last_active_alert_count: 0,
                    watch_last_active_id: '',
                    last_watch_scan_at: scannedAt,
                    last_watch_duration_ms: 0,
                    last_watch_status: 'sleep',
                    last_watch_error: '',
                    last_watch_source: source,
                    watch_debug_log: shouldAppendWatchDebugLog(accountRecord, sleepLogEntry)
                        ? buildNextWatchDebugLog(accountRecord, sleepLogEntry)
                        : (Array.isArray(accountRecord.watch_debug_log) ? accountRecord.watch_debug_log : []),
                    updated_at: new Date().toISOString(),
                });
            } catch (metaError) {
                console.warn('updateAccountMeta failed in watchAllSignsFast sleep branch:', metaError);
            }
            skipped += 1;
            return;
        }

        const session = createSession(accountRecord);
        const accountStartedAt = Date.now();
        let phaseBeforeScan = isValidWatchPhase(accountRecord.watch_phase) ? String(accountRecord.watch_phase) : 'sleep';
        if (currentWindow) {
            if (phaseBeforeScan === 'sleep') {
                phaseBeforeScan = nowMs < currentWindow.classStartMs ? 'preheat' : 'scanning';
            } else if (phaseBeforeScan === 'preheat' && nowMs >= currentWindow.classStartMs) {
                phaseBeforeScan = 'scanning';
            }
        } else {
            phaseBeforeScan = 'scanning';
        }

        try {
            const summary = await scanAndSyncAlertsForAccountFast(accountRecord, session);
            await persistSession(accountRecord, session);
            const activeAlertCount = Number(summary && summary.readyCount || 0) + Number(summary && summary.limitedCount || 0);
            const topAlert = Array.isArray(summary && summary.alerts) && summary.alerts.length
                ? summary.alerts[0]
                : null;
            const hasActiveAlert = activeAlertCount > 0;

            const signedAtMs = toTimestamp(accountRecord.watch_last_signed_at);
            const hasSignedInCurrentWindow = !!(currentWindow && signedAtMs && signedAtMs >= currentWindow.startMs && signedAtMs <= currentWindow.endMs + 10 * 60 * 1000);

            let phaseAfterScan = phaseBeforeScan;
            if (!currentWindow && source === 'timer') {
                phaseAfterScan = 'sleep';
            } else if (hasActiveAlert) {
                phaseAfterScan = 'active_hit';
            } else if (hasSignedInCurrentWindow || phaseBeforeScan === 'active_hit' || phaseBeforeScan === 'post_sign') {
                phaseAfterScan = currentWindow ? 'post_sign' : 'sleep';
            } else if (currentWindow && nowMs < currentWindow.classStartMs) {
                phaseAfterScan = 'preheat';
            } else {
                phaseAfterScan = 'scanning';
            }

            let nextScanAt = new Date(nowMs + pickPhaseIntervalMs(phaseAfterScan)).toISOString();
            let nextIntervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, toTimestamp(nextScanAt) - nowMs);

            if (source === 'timer') {
                if (!currentWindow) {
                    nextScanAt = nextWindow ? nextWindow.startAt : new Date(nowMs + WATCH_POLICY.sleepFallbackIntervalMs).toISOString();
                    nextIntervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, toTimestamp(nextScanAt) - nowMs);
                    phaseAfterScan = 'sleep';
                } else if (toTimestamp(nextScanAt) > currentWindow.endMs) {
                    if (nextWindow) {
                        nextScanAt = nextWindow.startAt;
                        nextIntervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, toTimestamp(nextScanAt) - nowMs);
                        phaseAfterScan = 'sleep';
                    } else {
                        const endSleepAt = new Date(currentWindow.endMs + 1000).toISOString();
                        nextScanAt = endSleepAt;
                        nextIntervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, toTimestamp(nextScanAt) - nowMs);
                    }
                }
            }

            const watchLogEntry = buildWatchDebugEntry({
                scannedAt,
                source,
                stage: 'scan_success',
                reason: currentWindow ? 'in_class_window' : 'manual_scan',
                watchPhase: phaseAfterScan,
                watchMode: phaseAfterScan,
                scheduleId,
                currentWindow,
                nextWindow,
                nextScanAt,
                nextIntervalMs,
                activeAlertCount,
                signActivityCount: Number(summary && summary.signActivityCount || 0),
                scannedCourseCount: Number(summary && summary.scannedCourseCount || 0),
                detectedActiveIds: Array.isArray(summary && summary.detectedActiveIds) ? summary.detectedActiveIds : [],
            });
            await updateAccountMeta(accountRecord, {
                last_watch_scan_at: scannedAt,
                last_watch_duration_ms: Date.now() - accountStartedAt,
                last_watch_status: 'success',
                last_watch_error: '',
                last_watch_source: source,
                watch_next_scan_at: nextScanAt,
                watch_next_interval_ms: nextIntervalMs,
                watch_mode: phaseAfterScan,
                watch_phase: phaseAfterScan,
                watch_today_key: todayKey,
                watch_today_windows: todayWindows.map(toWindowStorageItem),
                watch_current_window_index: currentWindow ? windowContext.currentWindowIndex : -1,
                watch_error_streak: 0,
                watch_last_active_alert_count: activeAlertCount,
                watch_last_active_id: hasActiveAlert && topAlert && topAlert.activeId
                    ? String(topAlert.activeId)
                    : (phaseAfterScan === 'post_sign' ? String(accountRecord.watch_last_active_id || '') : ''),
                watch_cooldown_until: '',
                watch_last_signed_at: accountRecord.watch_last_signed_at || '',
                watch_debug_log: buildNextWatchDebugLog(accountRecord, watchLogEntry),
                updated_at: new Date().toISOString(),
            });
            refreshed += 1;
        } catch (error) {
            const message = error && error.message ? error.message : '巡检失败';
            errors.push({
                openid: accountRecord.openid,
                message,
            });
            try {
                await persistSession(accountRecord, session);
            } catch (persistError) {
                console.warn('persistSession failed in watchAllSignsFast:', persistError);
            }
            try {
                const plan = buildErrorScanPlan(message, accountRecord, Date.now());
                const riskMode = isRiskControlMessage(message);
                const errorPhase = currentWindow ? 'scanning' : 'sleep';
                const cooldownUntil = riskMode ? new Date(Date.now() + plan.intervalMs).toISOString() : '';
                const fallbackNextScanAt = source === 'timer' && !currentWindow && nextWindow
                    ? nextWindow.startAt
                    : plan.nextScanAt;
                const fallbackIntervalMs = Math.max(WATCH_POLICY.timerMinIntervalMs, toTimestamp(fallbackNextScanAt) - nowMs);
                const watchLogEntry = buildWatchDebugEntry({
                    scannedAt,
                    source,
                    stage: 'scan_error',
                    reason: riskMode ? 'risk_control_or_rate_limit' : 'scan_failed',
                    watchPhase: errorPhase,
                    watchMode: plan.mode,
                    scheduleId,
                    currentWindow,
                    nextWindow,
                    nextScanAt: fallbackNextScanAt,
                    nextIntervalMs: fallbackIntervalMs,
                    error: message,
                });
                await updateAccountMeta(accountRecord, {
                    last_watch_scan_at: scannedAt,
                    last_watch_duration_ms: Date.now() - accountStartedAt,
                    last_watch_status: 'error',
                    last_watch_error: message,
                    last_watch_source: source,
                    watch_next_scan_at: fallbackNextScanAt,
                    watch_next_interval_ms: fallbackIntervalMs,
                    watch_mode: plan.mode,
                    watch_phase: errorPhase,
                    watch_today_key: todayKey,
                    watch_today_windows: todayWindows.map(toWindowStorageItem),
                    watch_current_window_index: currentWindow ? windowContext.currentWindowIndex : -1,
                    watch_error_streak: plan.errorStreak,
                    watch_cooldown_until: cooldownUntil,
                    watch_debug_log: buildNextWatchDebugLog(accountRecord, watchLogEntry),
                    updated_at: new Date().toISOString(),
                });
            } catch (metaError) {
                console.warn('updateAccountMeta failed in watchAllSignsFast:', metaError);
            }
        }
    });

    return {
        processed,
        refreshed,
        skipped,
        errors,
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
    };
}

exports.main = async (event) => {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID;
    const action = event && event.action
        ? event.action
        : (openid ? '' : 'watch_all_signs');
    const actionSource = event && event.action
        ? 'manual'
        : (openid ? 'mini_program' : 'timer');

    try {
        switch (action) {
            case 'get_account': {
                const record = await getAccountRecord(openid);
                return success(toClientAccount(record));
            }

            case 'login_password': {
                const username = ensureText(event.username, 'INVALID_USERNAME', '请输入超星账号或手机号');
                const password = ensureText(event.password, 'INVALID_PASSWORD', '请输入密码');
                const existing = await getAccountRecord(openid);
                const session = createSession(existing || {});
                await loginByPassword(session, username, password);
                const userInfo = await fetchUserInfo(session);
                const saved = await upsertAccount(openid, buildAccountPatch(existing, session, userInfo), existing);
                return success(toClientAccount(saved));
            }

            case 'send_sms_code': {
                const phone = ensureText(event.phone, 'INVALID_PHONE', '请输入手机号');
                const session = createSession();
                await sendSmsCode(session, phone);
                return success({ message: '验证码已发送' });
            }

            case 'login_sms': {
                const phone = ensureText(event.phone, 'INVALID_PHONE', '请输入手机号');
                const code = ensureText(event.code, 'INVALID_SMS_CODE', '请输入短信验证码');
                const existing = await getAccountRecord(openid);
                const session = createSession(existing || {});
                await loginBySms(session, phone, code);
                const userInfo = await fetchUserInfo(session);
                const saved = await upsertAccount(openid, buildAccountPatch(existing, session, userInfo), existing);
                return success(toClientAccount(saved));
            }

            case 'logout': {
                const record = await getAccountRecord(openid);
                if (record) {
                    await deleteCloudFile(record.last_sign_photo_file_id);
                    await db.collection(ACCOUNT_COLLECTION).doc(record._id).remove();
                }
                const alertRecords = await listAlertRecords(openid);
                for (const item of alertRecords) {
                    await db.collection(ALERT_COLLECTION).doc(item._id).remove();
                }
                return success({ loggedOut: true });
            }

            case 'list_courses': {
                return withBoundAccount(openid, async (record, session) => {
                    const courses = await fetchCourses(session);
                    return success({ courses });
                });
            }

            case 'list_activities': {
                const courseId = ensureText(event.courseId, 'INVALID_COURSE_ID', '缺少 courseId');
                const classId = ensureText(event.classId, 'INVALID_CLASS_ID', '缺少 classId');
                const cpi = ensureText(event.cpi, 'INVALID_CPI', '缺少 cpi');
                return withBoundAccount(openid, async (record, session) => {
                    const activities = await fetchActivities(session, {
                        courseId,
                        classId,
                        cpi,
                        accountUid: String(record.account_uid || ''),
                    });
                    return success({ activities });
                });
            }

            case 'get_activity_detail': {
                const activeId = ensureText(event.activeId, 'INVALID_ACTIVE_ID', '缺少 activeId');
                return withBoundAccount(openid, async (record, session) => {
                    const detail = await getActivityDetail(session, {
                        activeId,
                        signType: String(event.signType || ''),
                    });
                    return success(detail);
                });
            }

            case 'save_sign_photo': {
                const cloudFileId = ensureText(event.cloudFileId, 'INVALID_FILE_ID', '缺少云文件 ID');
                const fileName = ensureText(event.fileName, 'INVALID_FILE_NAME', '缺少文件名');
                const record = await getAccountRecord(openid);
                if (!record) {
                    throw appError('AUTH_REQUIRED', '请先绑定超星账号');
                }
                if (record.last_sign_photo_file_id && record.last_sign_photo_file_id !== cloudFileId) {
                    await deleteCloudFile(record.last_sign_photo_file_id);
                }
                const saved = await upsertAccount(openid, {
                    last_sign_photo_file_id: cloudFileId,
                    last_sign_photo_name: fileName,
                    last_sign_photo_updated_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }, record);
                return success(toClientAccount(saved));
            }

            case 'refresh_sign_notifications': {
                return withBoundAccount(openid, async (record, session) => {
                    const summary = await scanAndSyncAlertsForAccountFast(record, session);
                    return success(summary);
                });
            }

            case 'get_sign_notifications': {
                return withBoundAccount(openid, async () => {
                    const summary = await getOpenAlertSummary(openid);
                    return success(summary);
                });
            }

            case 'mark_sign_notifications_read': {
                return withBoundAccount(openid, async () => {
                    const summary = await markSignNotificationsRead(openid, String(event.activeId || ''));
                    return success(summary);
                });
            }

            case 'set_auto_sign_config': {
                const record = await getAccountRecord(openid);
                if (!record) {
                    throw appError('AUTH_REQUIRED', '请先绑定超星账号');
                }
                const enabled = !!event.enabled;
                const types = Array.isArray(event.types) ? event.types : ['normal', 'photo', 'code', 'pattern', 'location'];
                const validTypes = types.filter((t) => ['normal', 'photo', 'code', 'pattern', 'location'].includes(t));
                await db.collection(ACCOUNT_COLLECTION).doc(record._id).update({
                    data: {
                        auto_sign_enabled: enabled,
                        auto_sign_types: validTypes,
                        updated_at: new Date().toISOString(),
                    },
                });
                return success({
                    autoSignEnabled: enabled,
                    autoSignTypes: validTypes,
                });
            }

            case 'get_auto_sign_log': {
                const record = await getAccountRecord(openid);
                if (!record) {
                    throw appError('AUTH_REQUIRED', '请先绑定超星账号');
                }
                return success({
                    autoSignEnabled: !!record.auto_sign_enabled,
                    autoSignTypes: Array.isArray(record.auto_sign_types) ? record.auto_sign_types : ['normal', 'photo', 'code', 'pattern', 'location'],
                    log: Array.isArray(record.auto_sign_log) ? record.auto_sign_log : [],
                });
            }

            case 'watch_all_signs': {
                const result = await watchAllSignsFast(actionSource);
                return success(result);
            }

            case 'sign_normal': {
                const courseId = ensureText(event.courseId, 'INVALID_COURSE_ID', '缺少 courseId');
                const activeId = ensureText(event.activeId, 'INVALID_ACTIVE_ID', '缺少 activeId');
                return withBoundAccount(openid, async (record, session) => {
                    const detail = await getActivityDetail(session, {
                        activeId,
                        signType: 'normal',
                    });
                    if (detail.signed) {
                        return success({ status: 'already_signed', message: '当前账号已经完成过这次签到' });
                    }
                    if (detail.needPhoto) {
                        throw appError('PHOTO_REQUIRED', '这次签到要求上传图片，请改用拍照签到');
                    }
                    if (detail.needCaptcha) {
                        throw appError('CAPTCHA_REQUIRED', '当前签到需要滑块验证，小程序一期暂不支持');
                    }
                    const result = await normalSign(session, {
                        courseId,
                        activeId,
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
                    });
                    await resolveAlertAfterSign(openid, activeId);
                    return success(result);
                });
            }

            case 'sign_code': {
                const courseId = ensureText(event.courseId, 'INVALID_COURSE_ID', '缺少 courseId');
                const activeId = ensureText(event.activeId, 'INVALID_ACTIVE_ID', '缺少 activeId');
                const signCode = ensureText(event.signCode, 'INVALID_SIGN_CODE', '请输入签到码');
                return withBoundAccount(openid, async (record, session) => {
                    const detail = await getActivityDetail(session, {
                        activeId,
                        signType: 'code',
                    });
                    if (detail.signed) {
                        return success({ status: 'already_signed', message: '当前账号已经完成过这次签到' });
                    }
                    if (detail.needCaptcha) {
                        throw appError('CAPTCHA_REQUIRED', '当前签到需要滑块验证，小程序一期暂不支持');
                    }
                    const result = await codeSign(session, {
                        courseId,
                        activeId,
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
                        signCode,
                    });

                    // 写入共享池（不论自身是覆盖重签名还是初次签，都提供该码供他人白嫖）
                    if (result && (result.status === 'success' || result.status === 'already_signed')) {
                        try {
                            const poolCodeRecord = await db.collection(SIGN_CODE_COLLECTION).where({ active_id: String(activeId) }).limit(1).get();
                            if (!poolCodeRecord.data || poolCodeRecord.data.length === 0) {
                                await db.collection(SIGN_CODE_COLLECTION).add({
                                    data: {
                                        active_id: String(activeId),
                                        course_id: String(courseId),
                                        sign_code: String(signCode),
                                        contributor: String(openid),
                                        created_at: new Date().toISOString()
                                    }
                                });
                            }
                        } catch (e) {
                            console.warn('[SignCode] 回写共享池异常', e);
                        }
                    }

                    await resolveAlertAfterSign(openid, activeId);
                    return success(result);
                });
            }

            case 'sign_location': {
                const courseId = ensureText(event.courseId, 'INVALID_COURSE_ID', '缺少 courseId');
                const activeId = ensureText(event.activeId, 'INVALID_ACTIVE_ID', '缺少 activeId');
                const address = ensureText(event.address, 'INVALID_ADDRESS', '缺少地址信息');
                const latitude = event.latitude;
                const longitude = event.longitude;
                if (!latitude || !longitude) {
                    throw appError('INVALID_LOCATION', '缺少经纬度信息');
                }
                return withBoundAccount(openid, async (record, session) => {
                    const detail = await getActivityDetail(session, {
                        activeId,
                        signType: 'location',
                    });
                    if (detail.signed) {
                        return success({ status: 'already_signed', message: '当前账号已经完成过这次签到' });
                    }
                    if (detail.needCaptcha) {
                        throw appError('CAPTCHA_REQUIRED', '当前签到需要滑块验证，小程序一期暂不支持');
                    }
                    const result = await locationSign(session, {
                        courseId,
                        activeId,
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
                        address,
                        latitude: String(latitude || '-1'),
                        longitude: String(longitude || '-1'),
                    });
                    await resolveAlertAfterSign(openid, activeId);
                    return success(result);
                });
            }

            case 'set_default_location': {
                const record = await getAccountRecord(openid);
                if (!record) {
                    throw appError('AUTH_REQUIRED', '请先绑定超星账号');
                }
                const address = ensureText(event.address, 'INVALID_ADDRESS', '缺少地址');
                const latitude = event.latitude;
                const longitude = event.longitude;
                if (!latitude || !longitude) {
                    throw appError('INVALID_LOCATION', '缺少经纬度');
                }
                const defaultLocation = { address, latitude: String(latitude), longitude: String(longitude) };
                await db.collection(ACCOUNT_COLLECTION).doc(record._id).update({
                    data: {
                        default_location: defaultLocation,
                        updated_at: new Date().toISOString(),
                    },
                });
                return success({ defaultLocation });
            }

            case 'sign_qrcode': {
                const scannedContent = ensureText(event.scannedContent, 'INVALID_QR_CONTENT', '未获取到二维码内容');
                return withBoundAccount(openid, async (record, session) => {
                    const loc = record.default_location || {};
                    const result = await performQrSign(session, {
                        scannedContent,
                        courseId: String(event.courseId || ''),
                        activeId: String(event.activeId || ''),
                        expectedActiveId: String(event.expectedActiveId || ''),
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
                        address: loc.address,
                        latitude: loc.latitude,
                        longitude: loc.longitude,
                    });
                    if (event.activeId) {
                        await resolveAlertAfterSign(openid, String(event.activeId));
                    }
                    return success(result);
                });
            }

            case 'sign_photo': {
                const courseId = ensureText(event.courseId, 'INVALID_COURSE_ID', '缺少 courseId');
                const activeId = ensureText(event.activeId, 'INVALID_ACTIVE_ID', '缺少 activeId');
                return withBoundAccount(openid, async (record, session) => {
                    if (!record.last_sign_photo_file_id) {
                        throw appError('PHOTO_REQUIRED', '请先选择签到图片');
                    }
                    const detail = await getActivityDetail(session, {
                        activeId,
                        signType: 'normal',
                    });
                    if (detail.signed) {
                        return success({ status: 'already_signed', message: '当前账号已经完成过这次签到' });
                    }
                    if (detail.needCaptcha) {
                        throw appError('CAPTCHA_REQUIRED', '当前签到需要滑块验证，小程序一期暂不支持');
                    }
                    const download = await cloud.downloadFile({
                        fileID: record.last_sign_photo_file_id,
                    });
                    const result = await photoSign(session, {
                        courseId,
                        activeId,
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
                        fileBuffer: toBuffer(download.fileContent),
                        fileName: record.last_sign_photo_name || 'sign.jpg',
                    });
                    await resolveAlertAfterSign(openid, activeId);
                    return success(result);
                });
            }

            case 'sign_pattern': {
                const courseId = ensureText(event.courseId, 'INVALID_COURSE_ID', '缺少 courseId');
                const activeId = ensureText(event.activeId, 'INVALID_ACTIVE_ID', '缺少 activeId');
                return withBoundAccount(openid, async (record, session) => {
                    const detail = await getActivityDetail(session, {
                        activeId,
                        signType: 'pattern',
                    });
                    if (detail.signed) {
                        return success({ status: 'already_signed', message: '当前账号已经完成过这次签到' });
                    }
                    if (detail.needCaptcha) {
                        throw appError('CAPTCHA_REQUIRED', '当前签到需要滑块验证，小程序一期暂不支持');
                    }
                    const result = await bruteForcePatternSign(session, {
                        courseId,
                        activeId,
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
                    });
                    if (!result) {
                        throw appError('PATTERN_FAILED', '系统自动穷举未命中或超时，请稍后再试或在超星App内完成');
                    }
                    await resolveAlertAfterSign(openid, activeId);
                    return success(result);
                });
            }

            default:
                throw appError('INVALID_ACTION', `无效操作: ${action || 'unknown'}`);
        }
    } catch (error) {
        const normalizedError = normalizeKnownError(error);
        console.error('assist_chaoxing failed:', action, error);
        return failure(normalizedError);
    }
};
