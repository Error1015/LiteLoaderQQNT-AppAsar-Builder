/**
 * QQ 启动入口转发层（app.asar 注入）
 *
 * 加载顺序：
 *   1. 先加载 LiteLoader 宿主（MakeQQGreatAgain），由它完成 Electron 挂钩、协议注册与插件加载；
 *      宿主 src/main.js 内部会自行 require QQ 本体入口（application.asar/app_launcher/index.js）。
 *   2. 如果宿主不存在 / 加载抛错 / 没有成功拉起本体入口，这里兜底 require 本体入口，
 *      保证 QQ 在宿主出问题时依然能正常启动。
 *
 * 宿主路径解析顺序（第一个存在的即采用）：
 *   1. 运行时环境变量 LQ_LOADER    —— 让同一份产物可以拷给宿主装在任意位置的人用
 *   2. 构建时注入的路径 LOADER_PATH —— build-asar.js --loader= 写死
 *   3. 常见安装位置自动探测
 *
 * 紧急恢复：设置环境变量 LQ_INJECT_DISABLE=1 可跳过宿主，直接启动原生 QQ。
 */

const path = require("node:path");
const fs = require("node:fs");

// 构建时由 build-asar.js 注入为字符串字面量
const LOADER_PATH = __LQ_LOADER_PATH__;

const TAG = "[LQ-Inject]";
const RES = process.resourcesPath;

// QQ 本体入口候选（按 QQNT 版本新旧排列），路径写法需与宿主 src/main.js 一致，
// 这样二次 require 会命中模块缓存，不会出现重复初始化。
const ENTRY_CANDIDATES = [
    path.join(RES, "app", "application.asar", "app_launcher", "index.js"),
    path.join(RES, "app", "app_launcher", "index.js"),
    path.join(RES, "app.asar", "app_launcher", "index.js"),
];

function log(...args) {
    try {
        console.log(TAG, ...args);
    } catch {
        /* 控制台不可用时忽略 */
    }
}

function fatal(title, err) {
    const detail = (err && (err.stack || err.message)) || String(err);
    log(title, detail);
    try {
        require("electron").dialog.showErrorBox(title, detail);
    } catch {
        /* 主进程尚未就绪时静默 */
    }
}

function isLoaded(file) {
    try {
        return Boolean(require.cache[require.resolve(file)]);
    } catch {
        return false;
    }
}

function pickEntry() {
    for (const file of ENTRY_CANDIDATES) {
        try {
            if (fs.existsSync(file)) return file;
        } catch {
            /* 忽略单个候选的探测异常 */
        }
    }
    return ENTRY_CANDIDATES[0];
}

function exists(target) {
    try {
        return Boolean(target) && fs.existsSync(target);
    } catch {
        return false;
    }
}

/** 枚举宿主候选目录：环境变量 > 构建注入 > 常见安装位置 */
function loaderCandidates() {
    const list = [];
    const push = (item) => {
        if (item && !list.includes(item)) list.push(item);
    };

    // 1. 运行时覆盖
    push(process.env.LQ_LOADER);
    // 2. 构建时注入
    push(LOADER_PATH);

    // 3. 常见安装位置：<QQ>/LiteLoaderQQNT、<QQ 同级>/LiteLoaderQQNT、resources 内、%APPDATA%
    try {
        // RES = <QQ>/versions/<ver>/resources
        const qqRoot = path.resolve(RES, "..", "..", "..");
        push(path.join(qqRoot, "LiteLoaderQQNT"));
        push(path.join(path.dirname(qqRoot), "LiteLoaderQQNT"));
    } catch {
        /* 路径推导失败则跳过 */
    }
    push(path.join(RES, "LiteLoaderQQNT"));
    push(path.join(RES, "app", "LiteLoaderQQNT"));
    push(process.env.APPDATA && path.join(process.env.APPDATA, "LiteLoaderQQNT"));
    push(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "LiteLoaderQQNT"));
    push("C:\\LiteLoaderQQNT");
    push("D:\\LiteLoaderQQNT");

    return list;
}

function resolveLoader() {
    const tried = [];
    for (const item of loaderCandidates()) {
        tried.push(item);
        if (exists(item)) return { path: item, tried };
    }
    return { path: "", tried };
}

function loadLoader() {
    if (process.env.LQ_INJECT_DISABLE === "1") {
        log("LQ_INJECT_DISABLE=1，跳过宿主，直接启动原生 QQ");
        return false;
    }

    const { path: loader, tried } = resolveLoader();
    if (!loader) {
        log("未找到 LiteLoaderQQNT 宿主，回退到 QQ 本体。可用 LQ_LOADER 环境变量指定目录。已尝试:");
        for (const item of tried.slice(0, 4)) log("  -", item);
        if (tried.length > 4) log(`  ... 共 ${tried.length} 个候选`);
        return false;
    }

    try {
        require(loader);
        log("宿主已加载:", loader);
        return true;
    } catch (err) {
        log("宿主加载失败，回退到 QQ 本体:", (err && err.message) || err);
        return false;
    }
}

loadLoader();

// 宿主正常工作时已经把本体入口拉起来了，这里只是兜底
const entry = pickEntry();
if (!isLoaded(entry)) {
    try {
        require(entry);
        log("QQ 本体入口已加载:", entry);
    } catch (err) {
        fatal("QQ 启动失败", err);
    }
}
