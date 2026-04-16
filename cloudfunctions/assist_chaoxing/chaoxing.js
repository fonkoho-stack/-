const crypto = require('crypto');
const { URL } = require('url');
const got = require('got');
const { CookieJar } = require('tough-cookie');
const FormData = require('form-data');

const CONSTANTS = {
    schildSalt: 'ipL$TkeiEmfy1gTXb2XHrdLN0a@7c^vu',
    sendCaptchaKey: 'jsDyctOCnay7uotq',
    appLoginKey: 'z4ok6lu^oWp4_AES',
    deviceCodeKey: 'QrCbNY@MuK1X8HGw',
    infEncToken: '4faa8662c59590c6f43ae9fe5b002b42',
    infEncKey: 'Z(AfY@XS',
    systemHttpAgent: 'Dalvik/2.1.0 (Linux; U; Android 15; PKG110 Build/UKQ1.231108.001)',
    device: 'PKG110',
    productId: '3',
    version: '6.7.2',
    versionCode: '10936',
    apiVersion: '311',
};

const ACTIVE_TYPE_MAP = {
    2: { key: 'signIn', label: '签到' },
    4: { key: 'answer', label: '抢答' },
    5: { key: 'topicDiscuss', label: '主题讨论' },
    11: { key: 'pick', label: '选人' },
    14: { key: 'questionnaire', label: '问卷' },
    17: { key: 'live', label: '直播' },
    23: { key: 'evaluation', label: '评分' },
    35: { key: 'groupTask', label: '分组任务' },
    40: { key: 'pptClass', label: 'PPT课堂' },
    42: { key: 'quiz', label: '随堂练习' },
    43: { key: 'vote', label: '投票' },
    45: { key: 'notice', label: '通知' },
    46: { key: 'feedback', label: '学生反馈' },
    47: { key: 'timer', label: '计时器' },
    49: { key: 'whiteboard', label: '白板' },
    51: { key: 'syncCourse', label: '同步课堂' },
    54: { key: 'scheduledSignIn', label: '定时签到' },
    56: { key: 'cxMeeting', label: '超星课堂' },
    59: { key: 'draw', label: '抽签' },
    64: { key: 'tencentMeeting', label: '腾讯会议' },
    68: { key: 'interactivePractice', label: '互动练习' },
    74: { key: 'signOut', label: '签退' },
    77: { key: 'aiEvaluate', label: 'AI实训' },
};

const SIGN_TYPE_MAP = {
    0: { key: 'normal', label: '普通签到' },
    2: { key: 'qrcode', label: '二维码签到' },
    3: { key: 'pattern', label: '手势签到' },
    4: { key: 'location', label: '定位签到' },
    5: { key: 'code', label: '签到码签到' },
};

function appError(code, message, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

function md5(textOrBuffer) {
    return crypto.createHash('md5').update(textOrBuffer).digest('hex');
}

function aesEcbEncrypt(text, key) {
    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function createUuid() {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createUniqueId() {
    return createUuid().replace(/-/g, '');
}

function buildUserAgent(uniqueId) {
    const temp = `(device:${CONSTANTS.device}) Language/zh_CN com.chaoxing.mobile/ChaoXingStudy_${CONSTANTS.productId}_${CONSTANTS.version}_android_phone_${CONSTANTS.versionCode}_${CONSTANTS.apiVersion} (@Kalimdor)_${uniqueId}`;
    const schild = md5(`(schild:${CONSTANTS.schildSalt}) ${temp}`);
    return `${CONSTANTS.systemHttpAgent} (schild:${schild}) ${temp}`;
}

function normalizeDeviceIdentity(identity = {}) {
    return {
        uniqueId: identity.uniqueId || identity.unique_id || createUniqueId(),
        oaid: identity.oaid || createUuid(),
    };
}

function deserializeCookieJar(cookieBlob) {
    if (!cookieBlob) {
        return new CookieJar(undefined, { looseMode: true });
    }
    try {
        return CookieJar.deserializeSync(cookieBlob);
    } catch (error) {
        return new CookieJar(undefined, { looseMode: true });
    }
}

function createSession(record = {}) {
    const deviceIdentity = normalizeDeviceIdentity(record.device_identity);
    return {
        cookieJar: deserializeCookieJar(record.cookie_blob),
        deviceIdentity,
        userAgent: buildUserAgent(deviceIdentity.uniqueId),
        accountUid: record.account_uid ? String(record.account_uid) : '',
        accountName: record.display_name || '',
    };
}

function serializeSession(session) {
    return {
        cookie_blob: session.cookieJar.serializeSync(),
        device_identity: session.deviceIdentity,
    };
}

function buildHeaders(session, headers = {}) {
    return {
        'User-Agent': session.userAgent,
        'Accept-Language': 'zh_CN',
        'Connection': 'keep-alive',
        'Accept-Encoding': 'gzip',
        ...headers,
    };
}

function parseJsonSafe(text) {
    if (text == null || text === '') {
        return null;
    }
    if (typeof text !== 'string') {
        return text;
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

function looksLikeLoginPage(url, rawBody) {
    if (url && /passport2\.chaoxing\.com\/(login|fanyalogin)|sso\.chaoxing\.com\/login/i.test(url)) {
        return true;
    }
    if (typeof rawBody !== 'string') {
        return false;
    }
    return rawBody.includes('passport2.chaoxing.com/login') && rawBody.includes('<html');
}

async function request(session, url, options = {}) {
    const {
        method = 'GET',
        params,
        form,
        headers,
        responseType = 'json',
        body,
        followRedirect = true,
    } = options;

    const gotOptions = {
        method,
        searchParams: params,
        headers: buildHeaders(session, headers),
        cookieJar: session.cookieJar,
        followRedirect,
        throwHttpErrors: false,
        retry: 0,
        responseType: responseType === 'buffer' ? 'buffer' : 'text',
    };

    if (form) {
        gotOptions.form = form;
    }
    if (body) {
        gotOptions.body = body;
    }

    const response = await got(url, gotOptions);
    const rawBody = response.body;
    const finalBody = responseType === 'json' ? parseJsonSafe(rawBody) : rawBody;

    if (looksLikeLoginPage(response.url, rawBody)) {
        throw appError('SESSION_EXPIRED', '超星登录态已失效，请重新登录');
    }

    return {
        statusCode: response.statusCode,
        headers: response.headers,
        url: response.url,
        body: finalBody,
        rawBody,
    };
}

function buildEncParams(baseParams) {
    const entries = Object.entries(baseParams).map(([key, value]) => [key, String(value == null ? '' : value)]);
    const extraEntries = [
        ['_c_0_', createUniqueId()],
        ['token', CONSTANTS.infEncToken],
        ['_time', String(Date.now())],
    ];
    const query = [...entries, ...extraEntries]
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');

    return {
        _c_0_: extraEntries[0][1],
        token: extraEntries[1][1],
        _time: extraEntries[2][1],
        inf_enc: md5(`${query}&DESKey=${CONSTANTS.infEncKey}`),
    };
}

function buildDeviceCode(session) {
    return aesEcbEncrypt(session.deviceIdentity.oaid, CONSTANTS.deviceCodeKey);
}

function maskPhone(phone) {
    const text = String(phone || '');
    if (text.length >= 11) {
        return `${text.slice(0, 3)}****${text.slice(-4)}`;
    }
    return text;
}

function getMimeType(fileName = '') {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.png')) {
        return 'image/png';
    }
    if (lower.endsWith('.webp')) {
        return 'image/webp';
    }
    if (lower.endsWith('.heic')) {
        return 'image/heic';
    }
    return 'image/jpeg';
}

function buildUploadFileName(fileName = '') {
    const now = new Date();
    const pad = (value, size = 2) => String(value).padStart(size, '0');
    const extMatch = fileName.match(/\.[^.]+$/);
    const ext = extMatch ? extMatch[0] : '.jpg';
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}${ext}`;
}

function calculateChaoxingCrc(buffer) {
    const totalSize = buffer.length;
    let hashBuffer = buffer;
    if (totalSize > 1024 * 1024) {
        hashBuffer = Buffer.concat([
            buffer.subarray(0, 512 * 1024),
            buffer.subarray(totalSize - 512 * 1024),
        ]);
    }
    const sizeHex = Buffer.from(totalSize.toString(16), 'utf8');
    return md5(Buffer.concat([hashBuffer, sizeHex]));
}

function normalizeSignResponse(raw) {
    const text = String(raw || '').trim();
    if (!text) {
        throw appError('SIGN_FAILED', '签到返回为空');
    }
    if (text === 'success') {
        return { status: 'success', message: '签到成功', raw: text };
    }
    if (text === 'success2') {
        throw appError('SIGN_CLOSED', '当前签到已截止');
    }
    if (text.startsWith('validate')) {
        const parts = text.split('_');
        throw appError('CAPTCHA_REQUIRED', '当前签到需要滑块验证，小程序一期暂不支持', {
            raw: text,
            enc2: parts.length > 1 ? parts[1] : '',
        });
    }
    if (/已经签到|已签到/.test(text)) {
        return { status: 'already_signed', message: text, raw: text };
    }
    throw appError('SIGN_FAILED', text);
}

async function sendSmsCode(session, phone) {
    const time = String(Date.now());
    const enc = md5(`${phone}${CONSTANTS.sendCaptchaKey}${time}`);
    const response = await request(session, 'https://passport2-api.chaoxing.com/api/sendcaptcha', {
        method: 'POST',
        form: {
            to: phone,
            countrycode: '86',
            time,
            enc,
        },
    });
    const data = response.body;
    if (!data || data.status !== true) {
        throw appError('SMS_SEND_FAILED', (data && data.mes) || '验证码发送失败');
    }
    return data;
}

async function loginApp(session, loginType, username, codeOrPassword) {
    const loginInfo = aesEcbEncrypt(JSON.stringify({
        uname: username,
        code: codeOrPassword,
    }), CONSTANTS.appLoginKey);

    const form = {
        logininfo: loginInfo,
        loginType,
        roleSelect: 'true',
        entype: '1',
    };
    if (loginType === '2') {
        form.countrycode = '86';
    }

    const response = await request(session, 'https://passport2-api.chaoxing.com/v11/loginregister?cx_xxt_passport=json', {
        method: 'POST',
        form,
    });
    const data = response.body;
    if (!data || data.status !== true) {
        throw appError('LOGIN_FAILED', (data && data.mes) || '登录失败');
    }
    return data;
}

async function loginByPassword(session, username, password) {
    const data = await loginApp(session, '1', username, password);
    if (!data.url) {
        throw appError('SECURITY_VERIFICATION_REQUIRED', '当前账号需要额外安全验证，请改用短信验证码登录');
    }
    return data;
}

async function loginBySms(session, phone, code) {
    return loginApp(session, '2', phone, code);
}

async function fetchUserInfo(session) {
    const response = await request(session, 'https://sso.chaoxing.com/apis/login/userLogin4Uname.do');
    const payload = response.body;
    if (!payload || !payload.msg || !payload.msg.puid) {
        throw appError('SESSION_EXPIRED', '超星登录态已失效，请重新登录');
    }
    return payload.msg;
}

function buildAccountPatch(existingRecord, session, userInfo) {
    const now = new Date().toISOString();
    return {
        openid: existingRecord && existingRecord.openid,
        platform: 'chaoxing',
        account_uid: String(userInfo.puid || ''),
        display_name: userInfo.name || '未知用户',
        avatar_url: userInfo.pic || '',
        phone_masked: maskPhone(userInfo.phone || ''),
        cookie_blob: session.cookieJar.serializeSync(),
        device_identity: session.deviceIdentity,
        last_sign_photo_file_id: existingRecord ? existingRecord.last_sign_photo_file_id || '' : '',
        last_sign_photo_name: existingRecord ? existingRecord.last_sign_photo_name || '' : '',
        last_sign_photo_updated_at: existingRecord ? existingRecord.last_sign_photo_updated_at || '' : '',
        created_at: existingRecord && existingRecord.created_at ? existingRecord.created_at : now,
        updated_at: now,
    };
}

function parseCourseItem(channel) {
    const content = channel && channel.content ? channel.content : {};
    const courseData = content.course && content.course.data ? content.course.data[0] : null;
    if (!courseData) {
        return null;
    }
    return {
        courseId: String(courseData.id || ''),
        classId: String(content.id || ''),
        cpi: String(content.cpi || ''),
        image: courseData.imageurl || '',
        name: courseData.name || '未知课程',
        teacher: courseData.teacherfactor || '未知教师',
        schools: courseData.schools || '',
        note: content.name || '',
        state: Number(content.state) === 0,
        beginDate: content.beginDate || '',
        endDate: content.endDate || '',
    };
}

async function fetchCourses(session) {
    const response = await request(session, 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&getTchClazzType=1&mcode=');
    const payload = response.body;
    if (!payload || payload.result !== 1 || !Array.isArray(payload.channelList)) {
        throw appError('COURSE_FETCH_FAILED', '课程列表加载失败');
    }
    return payload.channelList
        .map(parseCourseItem)
        .filter(Boolean)
        .filter((item) => item.state);
}

async function getJoinClassTime(session, { courseId, classId, cpi, accountUid }) {
    const response = await request(session, 'https://mooc1-api.chaoxing.com/gas/clazzperson', {
        params: {
            courseid: courseId,
            clazzid: classId,
            userid: accountUid,
            personid: cpi,
            view: 'json',
            fields: 'clazzid,popupagreement,personid,clazzname,createtime',
        },
    });
    const data = response.body;
    const item = data && Array.isArray(data.data) ? data.data[0] : null;
    return item && item.createtime ? item.createtime : '';
}

async function getTaskActivityList(session, { courseId, classId, cpi, joinClassTime, accountUid }) {
    const baseParams = {
        courseId,
        classId,
        uid: accountUid,
        cpi,
        joinclasstime: joinClassTime,
    };
    const response = await request(session, 'https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist', {
        params: {
            ...baseParams,
            ...buildEncParams(baseParams),
        },
    });
    if (!response.body || !Array.isArray(response.body.activeList)) {
        throw appError('ACTIVITY_FETCH_FAILED', '活动列表加载失败');
    }
    return response.body.activeList;
}

async function getTaskActivityListWeb(session, { courseId, classId }) {
    const response = await request(session, 'https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist', {
        params: {
            fid: '0',
            courseId,
            classId,
            showNotStartedActive: '0',
            _: String(Date.now()),
        },
    });
    const activeList = response.body && response.body.data ? response.body.data.activeList : null;
    if (!Array.isArray(activeList)) {
        throw appError('ACTIVITY_FETCH_FAILED', '活动列表加载失败');
    }
    return activeList;
}

function parseActivityItem(item, pcItem = {}) {
    const activeTypeCode = Number(item.activeType || 0);
    const activeTypeMeta = ACTIVE_TYPE_MAP[activeTypeCode] || { key: 'unknown', label: '活动' };
    const signTypeMeta = SIGN_TYPE_MAP[Number(pcItem.otherId)];
    const signType = signTypeMeta ? signTypeMeta.key : '';
    const isSignActivity = ['signIn', 'signOut', 'scheduledSignIn'].includes(activeTypeMeta.key);
    let isSupported = false;
    let supportReason = '';

    if (!isSignActivity) {
        supportReason = '不是签到活动';
    } else if (Number(item.status) !== 1) {
        supportReason = '活动已结束';
    } else if (!signType) {
        supportReason = '暂时无法识别签到类型';
    } else {
        isSupported = true;
    }

    return {
        id: String(item.id || ''),
        type: activeTypeCode,
        activeType: activeTypeMeta.key,
        activeTypeLabel: activeTypeMeta.label,
        name: item.nameOne || '未命名活动',
        description: item.nameTwo || (Number(item.status) === 1 ? (pcItem.nameFour || '') : ''),
        startTime: item.startTime || 0,
        url: item.url || '',
        status: Number(item.status) === 1,
        signType,
        signTypeLabel: signTypeMeta ? signTypeMeta.label : '',
        isSupported,
        supportReason,
    };
}

async function fetchActivities(session, { courseId, classId, cpi, accountUid }) {
    const joinClassTime = await getJoinClassTime(session, { courseId, classId, cpi, accountUid });
    const [taskList, webList] = await Promise.all([
        getTaskActivityList(session, { courseId, classId, cpi, joinClassTime, accountUid }),
        getTaskActivityListWeb(session, { courseId, classId }),
    ]);
    const webMap = new Map(webList.map((item) => [String(item.id), item]));
    return taskList.map((item) => parseActivityItem(item, webMap.get(String(item.id)) || {}));
}

async function fetchActiveInfo(session, activeId) {
    const response = await request(session, `https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo?activeId=${encodeURIComponent(activeId)}`);
    return response.body;
}

async function fetchAttendInfo(session, activeId) {
    const response = await request(session, `https://mobilelearn.chaoxing.com/v2/apis/sign/getAttendInfo?activeId=${encodeURIComponent(activeId)}&moreClassAttendEnc=`);
    return response.body;
}

async function getActivityDetail(session, { activeId, signType }) {
    const [activeInfo, attendInfo] = await Promise.all([
        fetchActiveInfo(session, activeId),
        fetchAttendInfo(session, activeId),
    ]);

    const data = activeInfo && activeInfo.result === 1 ? activeInfo.data || {} : {};
    const attendData = attendInfo && attendInfo.result === 1 ? attendInfo.data || {} : {};
    const signTypeMeta = Object.values(SIGN_TYPE_MAP).find((item) => item.key === signType);

    const detail = {
        activeId: String(activeId),
        signType: signType || '',
        signTypeLabel: signTypeMeta ? signTypeMeta.label : '签到',
        needPhoto: Number(data.ifphoto) === 1,
        numberCount: Number(data.numberCount || 0),
        needCaptcha: Number(data.showVCode) === 1,
        signed: Number(attendData.status) === 1,
        locationText: data.locationText || '',
        locationRange: data.locationRange || '',
        unsupportedReason: '',
    };

    if (!detail.signType) {
        detail.unsupportedReason = '暂时无法识别签到类型';
    } else if (detail.signType === 'pattern') {
        // 手势签到已支持自动穷举破解
    } else if (detail.signType === 'location') {
        // 位置签到已支持
    }

    if (!detail.unsupportedReason && detail.needCaptcha) {
        detail.unsupportedReason = '当前签到需要滑块验证，小程序一期暂不支持';
    }

    detail.canSign = !detail.signed && !detail.unsupportedReason;
    return detail;
}

async function checkSignCode(session, activeId, signCode) {
    const response = await request(session, 'https://mobilelearn.chaoxing.com/widget/sign/pcStuSignController/checkSignCode', {
        params: {
            activeId,
            signCode,
        },
    });
    const data = response.body;
    if (!data || data.result !== 1) {
        throw appError('INVALID_SIGN_CODE', (data && data.errorMsg) || '签到码不正确');
    }
}

async function tryCheckSignCode(session, activeId, signCode) {
    try {
        const response = await request(session, 'https://mobilelearn.chaoxing.com/widget/sign/pcStuSignController/checkSignCode', {
            params: {
                activeId,
                signCode,
            },
        });
        const data = response.body;
        return data && data.result === 1;
    } catch (error) {
        return false;
    }
}

async function normalSign(session, { courseId, activeId, accountUid, accountName, objectId, validate }) {
    const params = {
        activeId,
        courseId: courseId || '',
        uid: accountUid,
        clientip: '',
        latitude: '-1',
        longitude: '-1',
        appType: '15',
        fid: '0',
        name: accountName || '',
        deviceCode: buildDeviceCode(session),
    };
    if (objectId) {
        params.objectId = objectId;
    }
    if (validate) {
        params.validate = validate;
    }
    const response = await request(session, 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax', {
        params,
        responseType: 'text',
    });
    return normalizeSignResponse(response.rawBody);
}

async function locationSign(session, { courseId, activeId, accountUid, accountName, address, latitude, longitude, validate }) {
    const params = {
        name: accountName || '',
        address: address || '未知位置',
        activeId,
        courseId: courseId || '',
        uid: accountUid,
        clientip: '',
        latitude: String(latitude || '-1'),
        longitude: String(longitude || '-1'),
        fid: '0',
        appType: '15',
        ifTiJiao: '1',
        deviceCode: buildDeviceCode(session),
        vpProbability: '-1',
        vpStrategy: '',
        currentFaceId: '',
        ifCFP: '0'
    };
    if (validate) {
        params.validate = validate;
    }
    const response = await request(session, 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax', {
        params,
        responseType: 'text',
    });
    return normalizeSignResponse(response.rawBody);
}

async function codeSign(session, { courseId, activeId, accountUid, accountName, signCode, validate }) {
    await checkSignCode(session, activeId, signCode);
    const params = {
        activeId,
        courseId,
        uid: accountUid,
        clientip: '',
        latitude: '-1',
        longitude: '-1',
        appType: '15',
        fid: '0',
        name: accountName || '',
        signCode,
        deviceCode: buildDeviceCode(session),
    };
    if (validate) {
        params.validate = validate;
    }
    const response = await request(session, 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax', {
        params,
        responseType: 'text',
    });
    return normalizeSignResponse(response.rawBody);
}

function extractQrPayload(urlText) {
    try {
        const url = new URL(urlText);
        if (url.hostname !== 'mobilelearn.chaoxing.com') {
            return null;
        }
        if (url.pathname === '/widget/sign/e') {
            return {
                activeId: url.searchParams.get('id') || '',
                enc: url.searchParams.get('enc') || '',
                courseId: url.searchParams.get('courseId') || '',
            };
        }
        if (url.pathname === '/newsign/preSign') {
            const rcode = decodeURIComponent(url.searchParams.get('rcode') || '');
            const match = rcode.match(/enc=([^&\s]+)/);
            return {
                activeId: url.searchParams.get('activePrimaryId') || url.searchParams.get('activeId') || '',
                enc: match ? match[1] : '',
                courseId: url.searchParams.get('courseId') || '',
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

async function resolveQrPayload(session, scannedContent) {
    const direct = extractQrPayload(scannedContent);
    if (direct && direct.activeId && direct.enc) {
        return direct;
    }
    if (!/^https?:\/\//i.test(scannedContent || '')) {
        throw appError('INVALID_QR_CONTENT', '无法识别该二维码内容');
    }
    const response = await request(session, scannedContent, {
        responseType: 'text',
        followRedirect: true,
    });
    const redirected = extractQrPayload(response.url);
    if (!redirected || !redirected.activeId || !redirected.enc) {
        throw appError('INVALID_QR_CONTENT', '无法识别该二维码内容');
    }
    return redirected;
}

async function qrCodeSign(session, { courseId, activeId, accountUid, accountName, enc, address, latitude, longitude, validate, enc2 }) {
    const params = {
        enc,
        name: accountName || '',
        activeId,
        uid: accountUid,
        clientip: '',
        location: '',
        latitude: '-1',
        longitude: '-1',
        fid: '0',
        appType: '15',
        deviceCode: buildDeviceCode(session),
        currentFaceId: '',
        ifCFP: '0',
        courseId: courseId || '',
    };
    if (address && latitude != null && longitude != null) {
        params.location = JSON.stringify({
            result: 1,
            latitude: Number(latitude),
            longitude: Number(longitude),
            mockData: { strategy: 0, probability: -1 },
            address: address
        });
    }
    if (validate && enc2) {
        params.validate = validate;
        params.enc2 = enc2;
    }
    const response = await request(session, 'https://mobilelearn.chaoxing.com/pptSign/stuSignajax', {
        params,
        responseType: 'text',
    });
    return normalizeSignResponse(response.rawBody);
}

async function performQrSign(session, { scannedContent, courseId, activeId, expectedActiveId, accountUid, accountName, address, latitude, longitude }) {
    const payload = await resolveQrPayload(session, scannedContent);
    const targetActiveId = activeId || payload.activeId;
    if (expectedActiveId && payload.activeId && String(expectedActiveId) !== String(payload.activeId)) {
        throw appError('QR_ACTIVITY_MISMATCH', '二维码不属于当前活动，请重新扫描');
    }
    const detail = await getActivityDetail(session, {
        activeId: targetActiveId,
        signType: 'qrcode',
    });
    if (detail.unsupportedReason) {
        throw appError('UNSUPPORTED_SIGN', detail.unsupportedReason);
    }
    return qrCodeSign(session, {
        courseId: courseId || payload.courseId || '',
        activeId: targetActiveId,
        accountUid,
        accountName,
        enc: payload.enc,
        address,
        latitude,
        longitude,
    });
}

async function uploadImageBuffer(session, { buffer, fileName, accountUid }) {
    const tokenResponse = await request(session, 'https://pan-yz.chaoxing.com/api/token/uservalid');
    const token = tokenResponse.body && tokenResponse.body._token;
    if (!token) {
        throw appError('PHOTO_UPLOAD_FAILED', '获取超星上传令牌失败');
    }

    await request(session, 'https://pan-yz.chaoxing.com/api/crcStorageStatus', {
        params: {
            puid: accountUid,
            crc: calculateChaoxingCrc(buffer),
            _token: token,
        },
    });

    const form = new FormData();
    form.append('file', buffer, {
        filename: buildUploadFileName(fileName),
        contentType: getMimeType(fileName),
    });
    form.append('puid', accountUid);

    const response = await request(session, `https://pan-yz.chaoxing.com/upload?_from=mobilelearn&_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: form.getHeaders(),
        body: form,
    });
    const objectId = response.body && response.body.data ? response.body.data.objectId : '';
    if (!objectId) {
        throw appError('PHOTO_UPLOAD_FAILED', '图片上传到超星失败');
    }
    return objectId;
}

async function photoSign(session, { courseId, activeId, accountUid, accountName, fileBuffer, fileName }) {
    const objectId = await uploadImageBuffer(session, {
        buffer: fileBuffer,
        fileName,
        accountUid,
    });
    return normalSign(session, {
        courseId,
        activeId,
        accountUid,
        accountName,
        objectId,
    });
}

module.exports = {
    appError,
    buildAccountPatch,
    codeSign,
    createSession,
    fetchActivities,
    fetchCourses,
    fetchUserInfo,
    locationSign,
    getActivityDetail,
    loginByPassword,
    loginBySms,
    normalSign,
    performQrSign,
    photoSign,
    sendSmsCode,
    serializeSession,
    tryCheckSignCode,
};
