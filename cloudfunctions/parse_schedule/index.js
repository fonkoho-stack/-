// 云函数：parse_schedule
// 功能：接收云存储中的 PDF fileID，解析课表并存入云数据库
const cloud = require('wx-server-sdk');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const path = require('path');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ========== 工具函数 ==========

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
        console.warn('parse_schedule getLatestScheduleRecord(created_at) failed:', openid, createdAtError);
    }

    if (!latest) {
        try {
            latest = await queryLatestScheduleRecord(openid, 'updated_at');
        } catch (updatedAtError) {
            console.warn('parse_schedule getLatestScheduleRecord(updated_at) failed:', openid, updatedAtError);
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
            console.warn('parse_schedule getLatestScheduleRecord(fallback) failed:', openid, fallbackError);
        }
    }

    return latest;
}

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function parseWeeks(weeksStr) {
    let oddEven = 'all';
    if (weeksStr.includes('(单)')) oddEven = 'odd';
    else if (weeksStr.includes('(双)')) oddEven = 'even';

    const m = weeksStr.match(/(\d+)(?:-(\d+))?/);
    const ranges = [];
    if (m) {
        const start = parseInt(m[1]);
        const end = m[2] ? parseInt(m[2]) : start;
        ranges.push({ start, end, odd_even: oddEven });
    }
    return { mode: 'range', ranges };
}

function extractCourseEventsFromText(text, dayOfWeek, pageIdx) {
    if (!text) return [];

    const markerRegex = /\((\d+)-(\d+)节\)/g;
    const markers = [];
    let match;
    while ((match = markerRegex.exec(text)) !== null) {
        markers.push({
            index: match.index,
            endIndex: match.index + match[0].length,
            pStart: parseInt(match[1]),
            pEnd: parseInt(match[2])
        });
    }
    if (markers.length === 0) return [];

    const events = [];
    for (let i = 0; i < markers.length; i++) {
        const mk = markers[i];
        let courseName = '';

        if (i === 0) {
            courseName = text.substring(0, mk.index).trim();
            // 首个课程如果包含上一节课的遗留信息（跨块拼接导致），可以用通用的已知后缀尝试截断
            const garbageMatch = courseName.match(/学分:\d+(?:\.\d+)?(.+)$/);
            if (garbageMatch) {
                courseName = garbageMatch[1].trim();
            } else {
                const suffixMatch = courseName.match(/[^:]+$/);
                if (suffixMatch) {
                    const parts = suffixMatch[0].split('/');
                    courseName = parts[parts.length - 1].trim();
                }
            }
        } else {
            const prevMk = markers[i - 1];
            const chunk = text.substring(prevMk.endIndex, mk.index);

            // chunk 包含了上一个课程剩余的所有 infoText，以及新课程的名字
            // 一般教务系统的特征是：上一门课通常以“...学分:X.X” 或 “...总学时:X” 或 “...选课备注:X”结束
            // 之后紧跟的才是下一节课的课程名。
            const possibleEndings = [/学分:\d+(?:\.\d+)?/, /总学时:\d+/, /选课备注:[^/]+/];
            let lastEndingIdx = -1;
            for (const re of possibleEndings) {
                const match = chunk.match(new RegExp(re.source + '(.+)$'));
                if (match) {
                    courseName = match[1].trim();
                    lastEndingIdx = match.index; // 随便标记一下找到了
                    break;
                }
            }

            // 如果没找到明确的结束点（比如没有学分），回退到原来的找 / 分隔符办法
            if (lastEndingIdx === -1) {
                const suffixMatch = chunk.match(/[^:]+$/);
                if (suffixMatch) {
                    const parts = suffixMatch[0].split('/');
                    courseName = parts[parts.length - 1].trim();
                } else {
                    courseName = chunk.trim();
                }
            }
        }

        let infoText = '';
        if (i < markers.length - 1) {
            const nextMk = markers[i + 1];
            const chunk = text.substring(mk.endIndex, nextMk.index);
            // 这里就不需要太复杂的截取了，交给下一轮找 courseName 即可，因为其实所有的正则匹配都在查全局 text，但安全起见为了本次提取场地等，我们尽量查全这个 chunk
            infoText = chunk;
        } else {
            infoText = text.substring(mk.endIndex);
        }

        const weeksMatch = infoText.match(/^(\d+(?:-\d+)?周(?:(?:\(单\))|(?:\(双\)))?)/);
        const weeksStr = weeksMatch ? weeksMatch[1] : '';
        const weeksObj = parseWeeks(weeksStr);

        const campusMatch = infoText.match(/校区:([^/场地]+)/);
        const roomMatch = infoText.match(/场地:([^/教师]+)/);
        const teacherMatch = infoText.match(/\/教师:([^/]+)/);

        courseName = courseName.replace(/^\d+\.\d+/, '');
        courseName = courseName.replace(/[★■▲◆☆]+$/, '').trim();

        const campus = campusMatch ? campusMatch[1].trim() : '';
        const room = roomMatch ? roomMatch[1].trim() : '';
        const rawLoc = `${campus} ${room}`.trim();

        events.push({
            id: uuid(),
            course_name: courseName,
            teacher: teacherMatch ? teacherMatch[1] : '',
            day_of_week: dayOfWeek,
            time: { type: 'period', period_start: mk.pStart, period_end: mk.pEnd },
            weeks: weeksObj,
            location: { campus: campus || null, building: campus || null, room: room || null, raw: rawLoc || null },
            reminder: { enabled: true, lead_minutes: 15 },
            evidence: { source_type: 'pdf_text', page_index: pageIdx, raw_text: infoText.substring(0, 50) },
            confidence: 0.9,
            needs_review: false,
            warnings: []
        });
    }
    return events;
}

/**
 * 通过二维坐标聚类恢复表格结构并提取课程
 */
function parseScheduleFromPages(pagesData) {
    const allEvents = [];

    let globalDayColumns = [];

    for (let pIdx = 0; pIdx < pagesData.length; pIdx++) {
        const items = pagesData[pIdx];
        if (!items || items.length === 0) continue;

        // 1. 聚类行，寻找表头
        const lines = [];
        for (const it of items) {
            let foundLine = lines.find(l => Math.abs(l.y - it.y) < 5);
            if (foundLine) {
                foundLine.items.push(it);
            } else {
                lines.push({ y: it.y, items: [it] });
            }
        }

        let headerLine = null;
        for (const line of lines) {
            line.items.sort((a, b) => a.x - b.x);
            const lineStr = line.items.map(it => it.str).join('');
            if (/星期[一二三四五六日天]/.test(lineStr) && lineStr.length < 100) {
                headerLine = line;
                break;
            }
        }

        let dayColumns = [];

        if (headerLine) {
            let charList = [];
            for (const it of headerLine.items) {
                const len = it.str.length || 1;
                const charW = it.w / len;
                for (let c = 0; c < len; c++) {
                    charList.push({ char: it.str[c], x: it.x + c * charW });
                }
            }
            const fullStr = charList.map(c => c.char).join('');
            const daysMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };

            for (const [dayChar, dayNum] of Object.entries(daysMap)) {
                const searchStr = '星期' + dayChar;
                const idx = fullStr.indexOf(searchStr);
                if (idx !== -1) {
                    const centerChar = charList[idx + 1]; // "期"字或"一"字的坐标作为中心
                    dayColumns.push({
                        day: dayNum,
                        xCenter: centerChar ? centerChar.x : 0
                    });
                }
            }

            dayColumns.sort((a, b) => a.xCenter - b.xCenter);
            if (dayColumns.length >= 2) {
                const colWidth = dayColumns[1].xCenter - dayColumns[0].xCenter;
                for (const col of dayColumns) {
                    col.xMin = col.xCenter - colWidth * 0.48;
                    col.xMax = col.xCenter + colWidth * 0.48;
                }
            }
        }

        if (dayColumns.length > 0) {
            globalDayColumns = dayColumns;
        } else if (globalDayColumns.length > 0) {
            dayColumns = globalDayColumns;
        } else {
            // 最差的 Fallback，但由于有了准确表头检测基本不会走这里
            const allXs = items.map(it => it.x);
            const minX = Math.min(...allXs);
            const maxX = Math.max(...allXs);
            const colW = (maxX - minX) / 8;
            for (let d = 1; d <= 7; d++) {
                const xC = minX + colW * d;
                dayColumns.push({
                    day: d,
                    xMin: xC - colW * 0.48,
                    xMax: xC + colW * 0.48
                });
            }
        }

        // 2. 将内容按列分配，并保留它们的 Y、X，以及高度
        const contentsByDay = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
        const contentItems = items.filter(it => !/星期[一二三四五六日天]/.test(it.str));

        for (const it of contentItems) {
            let foundDay = -1;
            for (const col of dayColumns) {
                if (it.x >= col.xMin && it.x <= col.xMax) {
                    foundDay = col.day;
                    break;
                }
            }
            if (foundDay !== -1) {
                contentsByDay[foundDay].push(it);
            }
        }

        // 3. 针对每一天的内容，进行行聚类（同一节课的行在 Y 坐标上是很接近的，不同课会有大 Gap）
        for (let d = 1; d <= 7; d++) {
            const dayItems = contentsByDay[d];
            if (!dayItems || dayItems.length === 0) continue;

            // PDF 坐标原点在左下角，Y 向上递增
            // 按 Y 从大到小排列（即页面从上到下排版）
            dayItems.sort((a, b) => b.y - a.y);

            // 进行 Y 坐标分块（聚类）：如果 Y 相差大于一个阈值（比如 12 像素），认为是换行，
            // 如果相差很大（比如 25 像素），认为是另外一节课的开始。
            const blocks = [];
            let currentBlock = [];

            for (let i = 0; i < dayItems.length; i++) {
                const current = dayItems[i];
                if (currentBlock.length === 0) {
                    currentBlock.push(current);
                } else {
                    const lastInBlock = currentBlock[currentBlock.length - 1];
                    // 只要高度差距大于某阈值，认为是新的逻辑块 (比如不同课或者分隔)
                    // 一般同一节课的换行行高差大概是 10-15。
                    if (Math.abs(lastInBlock.y - current.y) > 25) {
                        blocks.push(currentBlock);
                        currentBlock = [current];
                    } else {
                        currentBlock.push(current);
                    }
                }
            }
            if (currentBlock.length > 0) {
                blocks.push(currentBlock);
            }

            // 对每个 block（课）内部，由于可能同一行内左右有些偏移（比如前面是课名，后边是节次），
            // 应该先按 Y（微小容差下），再按 X 排序，拼接在一起
            for (const block of blocks) {
                // block 内再排序：如果 Y 差不多（比如小于 5 像素），按照 X 排序
                block.sort((a, b) => {
                    if (Math.abs(a.y - b.y) < 5) {
                        return a.x - b.x;
                    }
                    return b.y - a.y; // Y 决定先后序
                });

                const blockText = block.map(it => it.str).join('');
                const evs = extractCourseEventsFromText(blockText, d, pIdx);
                allEvents.push(...evs);
            }
        }
    }

    // ========== 后处理：合并连续的相同课程 ==========
    // 有些课会被拆分成两节独立的数据（比如 1-2节 和 3-4节是同一次大课）
    // 为了前端展示美观，我们将它们向上融合。
    const mergedEvents = [];
    for (let day = 1; day <= 7; day++) {
        const dayEvents = allEvents.filter(e => e.day_of_week === day);
        if (dayEvents.length === 0) continue;

        // 按开始节次排序
        dayEvents.sort((a, b) => a.time.period_start - b.time.period_start);

        const unmerged = [...dayEvents];

        while (unmerged.length > 0) {
            let currentEv = unmerged.shift();

            let i = 0;
            while (i < unmerged.length) {
                const nextEv = unmerged[i];

                // 连堂判断：下一个的开始不能早于当前的开始（因为排过序），且和上一个结束不超过 1 节
                const isConsecutive = (nextEv.time.period_start - currentEv.time.period_end <= 1) && (nextEv.time.period_start >= currentEv.time.period_start);

                let isMergeable = false;

                if (isConsecutive) {
                    // 只要是周次相同且连续，我们放宽同名同课判断，避免些微字符串空格或截断差异导致不合并
                    const isSameWeeks = JSON.stringify(currentEv.weeks) === JSON.stringify(nextEv.weeks);
                    if (isSameWeeks) {
                        const n1 = currentEv.course_name || '';
                        const n2 = nextEv.course_name || '';
                        // 名字高度重合 (完全包含或开头两三个字符一样，因为很可能一个截断了)
                        const isNameMatch = n1 === n2 || (n1 && n2 && (n1.includes(n2) || n2.includes(n1) || (n1.length >= 2 && n2.length >= 2 && n1.substring(0, 3) === n2.substring(0, 3))));

                        const t1 = currentEv.teacher || '';
                        const t2 = nextEv.teacher || '';
                        const isTeacherMatch = t1 === t2 || (!t1 || !t2) || t1.includes(t2) || t2.includes(t1);

                        const l1 = (currentEv.location && currentEv.location.raw) || '';
                        const l2 = (nextEv.location && nextEv.location.raw) || '';
                        const isLocMatch = l1 === l2 || (!l1 || !l2) || l1.includes(l2) || l2.includes(l1);

                        if (isNameMatch && isTeacherMatch && isLocMatch) {
                            isMergeable = true;
                        }
                    }
                }

                if (isMergeable) {
                    // 合并节次
                    currentEv.time.period_end = Math.max(currentEv.time.period_end, nextEv.time.period_end);
                    // 合并 evidence
                    currentEv.evidence.raw_text += ' | ' + nextEv.evidence.raw_text;
                    // 数据互补填补
                    if (!currentEv.teacher && nextEv.teacher) currentEv.teacher = nextEv.teacher;
                    if (!(currentEv.location && currentEv.location.raw) && (nextEv.location && nextEv.location.raw)) {
                        currentEv.location = nextEv.location;
                    }
                    // 从未合并列表中移除被吃掉的元素
                    unmerged.splice(i, 1);
                    // 游标归零，重新检查是否还有连堂
                    i = 0;
                    continue;
                }

                // 如果当前 nextEv 已经超过了 currentEv 结束位置 1 节以上，
                // 因为按 period_start 排序，越往后的课更是碰不到了，可以直接中断寻找以提升性能。
                if (nextEv.time.period_start > currentEv.time.period_end + 1) {
                    break;
                }

                i++;
            }

            mergedEvents.push(currentEv);
        }
    }

    return mergedEvents;
}

// ========== 云函数主入口 ==========
exports.main = async (event, context) => {
    const { fileID } = event;
    if (!fileID) {
        return { success: false, error: { code: 'MISSING_FILE_ID', message: '缺少 fileID 参数' } };
    }

    try {
        // 1. 下载 PDF
        const fileRes = await cloud.downloadFile({ fileID });
        const buffer = fileRes.fileContent;
        const uint8Array = new Uint8Array(buffer);

        // 2. 配置 pdfjs-dist 读取 PDF
        const CMAP_URL = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps') + '/';
        const loadingTask = pdfjsLib.getDocument({
            data: uint8Array,
            cMapUrl: CMAP_URL,
            cMapPacked: true,
            standardFontDataUrl: path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/',
            disableFontFace: true
        });

        const pdfDocument = await loadingTask.promise;
        const pagesData = [];
        let globalIsRotated = false;

        for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const textContent = await page.getTextContent();

            const rawItems = textContent.items.filter(it => it.str && it.str.trim().length > 0);

            // 启发式检测：这篇 PDF 是否被旋转了 90 度？
            // 取全局判断，防止第二页因为没有表头而退化为未旋转导致坐标大错乱
            let isRotated = globalIsRotated;
            const weekItems = rawItems.filter(it => /星期[一二三四五六日天]/.test(it.str));
            if (weekItems.length >= 2) {
                // 如果两个"星期X"的 x 坐标非常接近，但 y 坐标相差很大，说明轴向互换了
                if (Math.abs(weekItems[0].transform[4] - weekItems[1].transform[4]) < 10 &&
                    Math.abs(weekItems[0].transform[5] - weekItems[1].transform[5]) > 30) {
                    isRotated = true;
                    globalIsRotated = true; // 只要有一页确认旋转了，全篇都按旋转处理
                }
            }

            // 只需要提取文字内容, x 坐标 和 y 坐标 和宽度
            const pageItems = rawItems.map(it => {
                let x = it.transform[4];
                let y = it.transform[5];

                if (isRotated) {
                    // 如果旋转了，互换 x 和 y，并且根据一般习惯，Y应该是从上往下递增还是递减
                    // 对于 pdf，y 原本是从下往上（或者是从上往下取决于具体 PDF）。
                    // 我们只需把原来的 y 当做列坐标(x)，把 x 当做行坐标(y)。
                    // 并且因为是从星期一(y:133)到星期二(y:237)，说明原始Y是向右增长的，直接充当新 X 正合适。
                    // 原始X全是74，说明同一行在原 X 上是恒定的，所以直接充当新 Y
                    const temp = x;
                    x = y;
                    y = -temp; // 翻转行坐标使其符合正常的扫描流 (原本的X从左侧74到右侧越来越大，代表行在往下走，翻转可以使其和真实PDF渲染方向相容，但其实可以直接赋值)
                }

                return {
                    str: it.str.replace(/\s+/g, ''), // 去除内部空白
                    x: x,
                    y: y,
                    w: it.width || 0
                };
            }).filter(it => it.str.length > 0);

            pagesData.push(pageItems);
        }

        if (pagesData.length === 0 || pagesData[0].length === 0) {
            return {
                success: false,
                error: { code: 'PARSE_FAILED', message: 'PDF 内容为空或采用了扫描图片件，无法提取文本' }
            };
        }

        // ===== 课表特征检测：判断是否为课表 PDF =====
        const allText = pagesData.flat().map(it => it.str).join('');

        // 必须包含的核心特征（至少命中 2 个）
        const coreKeywords = [
            /星期[一二三四五六日天]/,   // 日期列头
            /\(\d+-\d+节\)/,           // 节次标记 (1-2节)
            /\d+-?\d*周/,             // 周次信息
        ];

        // 辅助特征（命中越多越确定是课表）
        const auxKeywords = [
            /课程|课表|教学|排课/,
            /教师|老师|任课/,
            /场地|教室|实验室/,
            /学分/,
            /校区/
        ];

        const coreHits = coreKeywords.filter(re => re.test(allText)).length;
        const auxHits = auxKeywords.filter(re => re.test(allText)).length;

        // 判定规则：核心特征至少命中 2 个，或核心 1 个 + 辅助 2 个以上
        const isSchedule = coreHits >= 2 || (coreHits >= 1 && auxHits >= 2);

        if (!isSchedule) {
            // 清理已上传的文件
            cloud.deleteFile({ fileList: [fileID] }).catch(() => { });
            return {
                success: false,
                error: {
                    code: 'NOT_SCHEDULE',
                    message: '该文件不像是课表 PDF，请上传教务系统导出的课程表文件。\n\n提示：课表通常包含"星期一~日"、"第X节"、"X周"等信息。'
                }
            };
        }

        // 3. 物理坐标系解析文本
        const events = parseScheduleFromPages(pagesData);

        if (events.length === 0) {
            // DEBUG: 把第一页前 100 个文本块连同坐标返回，让我们看看原始数据是什么鬼样子
            const debugItems = pagesData[0].slice(0, 80).map(it => `[${it.str} x:${Math.round(it.x)} y:${Math.round(it.y)}]`).join(' ');
            return {
                success: false,
                error: { code: 'PARSE_FAILED', message: `DEBUG - 提取为空。前 80 项长这样：${debugItems.substring(0, 800)}...` }
            };
        }

        // 4. 入库
        const wxContext = cloud.getWXContext();
        const openid = wxContext.OPENID;
        const latestSchedule = await getLatestScheduleRecord(openid);
        let scheduleId = '';

        if (latestSchedule && latestSchedule._id) {
            const nextVersion = Math.max(1, Number(latestSchedule.version || 1) + 1);
            await db.collection('schedules').doc(latestSchedule._id).update({
                data: {
                    events,
                    version: nextVersion,
                    updated_at: db.serverDate()
                }
            });
            scheduleId = latestSchedule._id;
        } else {
            const scheduleDoc = {
                openid,
                events,
                version: 1,
                subscription_count: 0,
                created_at: db.serverDate(),
                updated_at: db.serverDate()
            };
            const addRes = await db.collection('schedules').add({ data: scheduleDoc });
            scheduleId = addRes._id;
        }

        // 5. 阅后即焚
        cloud.deleteFile({ fileList: [fileID] }).catch(() => { });

        return {
            success: true,
            data: {
                schedule_id: scheduleId,
                events,
                events_count: events.length,
                warnings: [],
                needs_review_count: events.filter(e => e.needs_review).length
            }
        };
    } catch (err) {
        console.error('parse_schedule 执行失败:', err);
        return {
            success: false,
            error: { code: 'PARSE_FAILED', message: err.message || '解析异常' }
        };
    }
};
