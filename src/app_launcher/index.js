/**
 * QQ 启动入口转发层（app.asar 注入）
 *
 * 加载顺序：
 *   1. 先加载 LiteLoader 宿主（MakeQQGreatAgain），由它完成 Electron 挂钩、协议注册与插件加载；
 *      宿主 src/main.js 内部会自行 require QQ 本体入口（application.asar/app_launcher/index.js）。
 *   2. 如果宿主不存在 / 加载抛错 / 没有成功拉起本体入口，这里兜底 require 本体入口，
 *      保证 QQ 在宿主出问题时依然能正常启动。
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

function loadLoader() {
    if (process.env.LQ_INJECT_DISABLE === "1") {
        log("LQ_INJECT_DISABLE=1，跳过宿主，直接启动原生 QQ");
        return false;
    }
    if (!fs.existsSync(LOADER_PATH)) {
        log("宿主目录不存在，跳过宿主:", LOADER_PATH);
        return false;
    }
    try {
        require(LOADER_PATH);
        log("宿主已加载:", LOADER_PATH);
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
