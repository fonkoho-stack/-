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
const COURSE_SCAN_CONCURRENCY = 4;
const ACCOUNT_SCAN_CONCURRENCY = 2;

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

function buildAlertSummary(alerts) {
    const readyCount = alerts.filter((item) => item.status === 'ready').length;
    const limitedCount = alerts.filter((item) => item.status === 'limited').length;
    const unreadCount = alerts.filter((item) => !item.isRead).length;
    return {
        alerts,
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
    } else if (detail.signType === 'pattern') {
        detail.unsupportedReason = '手势签到一期暂不支持';
    } else if (detail.signType === 'location') {
        detail.unsupportedReason = '定位签到一期暂不支持';
    }

    if (!detail.unsupportedReason && activity && !activity.isSupported && activity.supportReason) {
        detail.unsupportedReason = activity.supportReason;
    }

    detail.canSign = !detail.signed && !detail.unsupportedReason;
    return detail;
}

function shouldFetchActivityDetailForAlert(activity) {
    if (!activity || !activity.status || !activity.isSupported) {
        return false;
    }
    return ['normal', 'code', 'qrcode'].includes(activity.signType);
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
        autoSignEnabled: !!record.auto_sign_enabled,
        autoSignTypes: Array.isArray(record.auto_sign_types) ? record.auto_sign_types : ['normal', 'photo', 'pattern'],
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
        helperText = '已检测到定位签到，当前小程序暂不支持。';
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

        for (const activity of signActivities) {
            seenActiveIds.add(String(activity.id));
            const existingRecord = existingMap.get(String(activity.id));

            if (!activity.status) {
                if (existingRecord && existingRecord.is_active) {
                    await closeAlertRecord(existingRecord, 'closed', '该签到已经结束。');
                }
                continue;
            }

            let detail = buildFallbackActivityDetail(activity);
            if (shouldFetchActivityDetailForAlert(activity)) {
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
            if (detail.canSign && accountRecord.auto_sign_enabled) {
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

    return buildAlertSummary(sortAlerts(activeAlerts));
}

async function getOpenAlertSummary(openid) {
    const records = await listAlertRecords(openid);
    const alerts = sortAlerts(
        records
            .filter((item) => item.is_active)
            .map((item) => toClientAlert(item))
    );
    return buildAlertSummary(alerts);
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
        : ['normal', 'photo', 'code', 'pattern'];

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
        if (effectiveType === 'normal' || effectiveType === 'code') {
            // code 类型尝试免码签到：直接调用普通签到接口，不传 signCode
            // 部分情况下服务端不强制校验签到码，可以成功
            result = await normalSign(session, {
                courseId: course.courseId,
                activeId: String(activity.id),
                accountUid: String(accountRecord.account_uid || ''),
                accountName: accountRecord.display_name || '',
            });
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
    let processed = 0;
    let refreshed = 0;
    const errors = [];

    await mapWithConcurrency(accounts, ACCOUNT_SCAN_CONCURRENCY, async (accountRecord) => {
        processed += 1;
        const session = createSession(accountRecord);
        const accountStartedAt = Date.now();
        const scannedAt = new Date().toISOString();
        try {
            await scanAndSyncAlertsForAccountFast(accountRecord, session);
            await persistSession(accountRecord, session);
            await updateAccountMeta(accountRecord, {
                last_watch_scan_at: scannedAt,
                last_watch_duration_ms: Date.now() - accountStartedAt,
                last_watch_status: 'success',
                last_watch_error: '',
                last_watch_source: source,
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
                await updateAccountMeta(accountRecord, {
                    last_watch_scan_at: scannedAt,
                    last_watch_duration_ms: Date.now() - accountStartedAt,
                    last_watch_status: 'error',
                    last_watch_error: message,
                    last_watch_source: source,
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
                const types = Array.isArray(event.types) ? event.types : ['normal', 'photo'];
                const validTypes = types.filter((t) => ['normal', 'photo', 'code'].includes(t));
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
                    autoSignTypes: Array.isArray(record.auto_sign_types) ? record.auto_sign_types : ['normal', 'photo'],
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
                    await resolveAlertAfterSign(openid, activeId);
                    return success(result);
                });
            }

            case 'sign_qrcode': {
                const scannedContent = ensureText(event.scannedContent, 'INVALID_QR_CONTENT', '未获取到二维码内容');
                return withBoundAccount(openid, async (record, session) => {
                    const result = await performQrSign(session, {
                        scannedContent,
                        courseId: String(event.courseId || ''),
                        activeId: String(event.activeId || ''),
                        expectedActiveId: String(event.expectedActiveId || ''),
                        accountUid: String(record.account_uid || ''),
                        accountName: record.display_name || '',
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

            default:
                throw appError('INVALID_ACTION', `无效操作: ${action || 'unknown'}`);
        }
    } catch (error) {
        const normalizedError = normalizeKnownError(error);
        console.error('assist_chaoxing failed:', action, error);
        return failure(normalizedError);
    }
};
