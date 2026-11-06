/**
 * 生成注入用的 app.asar。
 *
 * 产物：<项目根>/app.asar
 * 结构：
 *   package.json            -> main 指向 app_launcher/index.js
 *   app_launcher/index.js   -> 先加载宿主，再兜底拉起 QQ 本体入口
 *
 * 用法：
 *   node build-asar.js                        # 使用默认宿主路径
 *   node build-asar.js --loader="D:\\path"    # 指定宿主目录
 *   node build-asar.js --qq="D:\\App\\QQ"     # 指定 QQ 安装目录（用于读取版本号）
 */

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "app.asar");

const DEFAULT_LOADER = String.raw`D:\\App\\LiteLoaderQQNT`;
const DEFAULT_QQ = String.raw`D:\\App\\QQ`;

function arg(name) {
    const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

const loaderPath = path.resolve(arg("loader") || process.env.LQ_LOADER || DEFAULT_LOADER);
const qqDir = path.resolve(arg("qq") || process.env.LQ_QQ_DIR || DEFAULT_QQ);

/** 读取 QQ 当前生效版本的 resources/app/package.json，用于对齐 name/productName/version */
function readOfficialManifest() {
    const versionsDir = path.join(qqDir, "versions");
    let version = "";
    try {
        const config = JSON.parse(fs.readFileSync(path.join(versionsDir, "config.json"), "utf8"));
        version = config.curVersion || config.baseVersion || "";
    } catch {
        /* 读不到就退回扫描目录 */
    }
    if (!version) {
        const dirs = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir, { withFileTypes: true }) : [];
        const found = dirs.filter((item) => item.isDirectory()).map((item) => item.name).sort().pop();
        version = found || "";
    }
    const manifestPath = path.join(versionsDir, version, "resources", "app", "package.json");
    try {
        return { path: manifestPath, data: JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
    } catch {
        return { path: manifestPath, data: null };
    }
}

/** 删除文件或目录；被安全删除钩子拦截时退化为静默清理 */
function clean(target) {
    try {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch {
        /* 清理失败不影响构建，asar 写入会覆盖同名文件 */
    }
}

function build() {
    if (!fs.existsSync(loaderPath)) {
        throw new Error(`宿主目录不存在: ${loaderPath}`);
    }

    const official = readOfficialManifest();
    const base = official.data || {};

    const manifest = {
        name: base.name || "qq-chat",
        version: base.version || "",
        private: true,
        description: base.description || "QQ",
        productName: base.productName || "QQ",
        author: base.author,
        homepage: base.homepage,
        sideEffects: base.sideEffects !== undefined ? base.sideEffects : true,
        bin: base.bin,
        // 注入点：改为我们自己的入口
        main: "./app_launcher/index.js",
        buildVersion: base.buildVersion,
        isPureShell: base.isPureShell,
        isByteCodeShell: base.isByteCodeShell,
        platform: base.platform,
        eleArch: base.eleArch,
    };
    if (!manifest.version) delete manifest.version;
    for (const key of Object.keys(manifest)) {
        if (manifest[key] === undefined) delete manifest[key];
    }

    const entrySource = fs.readFileSync(path.join(SRC, "app_launcher", "index.js"), "utf8");
    // 用 JSON.stringify 注入，天然处理反斜杠转义
    const entryCode = entrySource.replace("__LQ_LOADER_PATH__", JSON.stringify(loaderPath));

    const staging = path.join(ROOT, ".staging");
    clean(staging);
    fs.mkdirSync(path.join(staging, "app_launcher"), { recursive: true });
    fs.mkdirSync(path.join(staging, "application"), { recursive: true });
    fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(staging, "app_launcher", "index.js"), entryCode, "utf8");
    fs.writeFileSync(
        path.join(staging, "application", "background.js"),
        fs.readFileSync(path.join(SRC, "application", "background.js"), "utf8"),
        "utf8"
    );

    clean(OUT);
    asar.createPackage(staging, OUT).then(() => {
        fs.rmSync(staging, { recursive: true, force: true });
        const size = fs.statSync(OUT).size;
        console.log("已生成:", OUT, `(${size} 字节)`);
        console.log("宿主路径:", loaderPath);
        console.log("对齐清单:", official.path, official.data ? "(已读取)" : "(未找到，使用默认值)");
        console.log("包内文件:");
        for (const item of asar.listPackage(OUT)) console.log("  " + item);
        console.log("\n下一步: node install.js    # 部署到 QQ 并在必要时重启验证");
    }).catch((err) => {
        fs.rmSync(staging, { recursive: true, force: true });
        console.error("生成失败:", err);
        process.exitCode = 1;
    });
}

try {
    build();
} catch (err) {
    console.error("生成失败:", err.message);
    process.exitCode = 1;
}
