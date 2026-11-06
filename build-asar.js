/**
 * 生成注入用的 app.asar。
 *
 * 产物：<out>/app.asar
 * 结构：
 *   package.json            -> main 指向 app_launcher/index.js
 *   app_launcher/index.js   -> 先加载宿主，再兜底拉起 QQ 本体入口
 *   application/background.js -> 转发到 QQ 原生 application.asar
 *
 * 配置来源优先级（高 → 低）：
 *   1. 命令行参数：--loader= --qq= --out= --manifest= --qq-version= --build-version=
 *   2. 环境变量：LQ_LOADER / LQ_QQ_DIR / LQ_OUT / LQ_MANIFEST
 *   3. 项目根 .lqrc.json：{ "loader": "...", "qq": "...", "out": "..." }
 *   4. 内置默认值
 *
 * 用法：
 *   node build-asar.js                                  # 本地：默认宿主路径
 *   node build-asar.js --loader="D:/App/LiteLoaderQQNT" # 自定义宿主目录
 *   node build-asar.js --loader="C:/LiteLoaderQQNT" --allow-missing-loader --out=dist
 *                                                       # CI：宿主不在构建机上也能出通用产物
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("@electron/asar");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");

const DEFAULT_LOADER = String.raw`D:\App\LiteLoaderQQNT`;
const DEFAULT_QQ = String.raw`D:\App\QQ`;

/**
 * 构建机上没有 QQ 时使用的基线清单。
 * 字段与 QQNT 9.9.37 原生 resources/app/package.json 保持一致，
 * 避免产物因缺字段导致 QQ 启动异常。
 */
const FALLBACK_MANIFEST = {
    name: "qq-chat",
    version: "9.9.37-54395",
    private: true,
    description: "QQ",
    productName: "QQ",
    author: { name: "Tencent", email: "QQ-Team@tencent.com" },
    homepage: "https://im.qq.com",
    sideEffects: true,
    bin: { qd: "externals/devtools/cli/index.js" },
    buildVersion: "54395",
    isPureShell: true,
    isByteCodeShell: true,
    platform: "win32",
    eleArch: "x64",
};

function arg(name) {
    const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

function flag(name) {
    return process.argv.includes(`--${name}`);
}

/** 读取可选的项目级配置 */
function readRc() {
    const file = path.join(ROOT, ".lqrc.json");
    try {
        return { file, data: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
        return { file, data: {} };
    }
}

const WIN_ABS = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\/;

/**
 * 解析外部传入的路径。
 *
 * Windows 盘符路径与 UNC 路径必须原样保留：GitHub Actions 跑在 Linux runner 上，
 * path.resolve("C:/LiteLoaderQQNT") 会得到 /home/runner/work/.../C:/LiteLoaderQQNT，
 * 这个值被写进产物后在 Windows 上永远不存在，等于把"构建时固定宿主路径"彻底废掉。
 */
function resolveExternal(input, fallback) {
    const raw = String(input || fallback || "").trim();
    if (!raw) return "";
    if (WIN_ABS.test(raw) || UNC_PATH.test(raw)) return raw.replace(/\//g, "\\");
    return path.resolve(raw);
}

const rc = readRc();
const cfg = rc.data || {};

const loaderPath = resolveExternal(arg("loader") || process.env.LQ_LOADER || cfg.loader, DEFAULT_LOADER);
const qqDir = resolveExternal(arg("qq") || process.env.LQ_QQ_DIR || cfg.qq, DEFAULT_QQ);
const outDir = resolveExternal(arg("out") || process.env.LQ_OUT || cfg.out, ROOT);
const manifestOverride = resolveExternal(arg("manifest") || process.env.LQ_MANIFEST || cfg.manifest, "");
const qqVersionOverride = arg("qq-version") || process.env.LQ_QQ_VERSION || cfg.qqVersion || "";
const buildVersionOverride = arg("build-version") || process.env.LQ_BUILD_VERSION || cfg.buildVersion || "";
const allowMissingLoader = flag("allow-missing-loader");

const OUT = path.join(outDir, "app.asar");
const INFO = path.join(outDir, "build-info.json");

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

/** 解析基线清单：显式指定 > 本地 QQ > 内置默认 */
function resolveBaseManifest() {
    if (manifestOverride) {
        const file = manifestOverride;
        try {
            return { data: JSON.parse(fs.readFileSync(file, "utf8")), source: `${file} (--manifest)` };
        } catch (err) {
            throw new Error(`无法读取 --manifest 指定的清单 ${file}: ${err.message}`);
        }
    }
    const official = readOfficialManifest();
    if (official.data) return { data: official.data, source: `${official.path} (本地 QQ)` };
    return { data: FALLBACK_MANIFEST, source: "内置基线清单 (未找到本地 QQ)" };
}

/** 删除文件或目录；被安全删除钩子拦截时退化为静默清理 */
function clean(target) {
    try {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch {
        /* 清理失败不影响构建，asar 写入会覆盖同名文件 */
    }
}

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function build() {
    const loaderExists = fs.existsSync(loaderPath);
    if (!loaderExists) {
        if (!allowMissingLoader) {
            throw new Error(
                `宿主目录不存在: ${loaderPath}\n` +
                    `      本地构建请用 --loader="你的 LiteLoaderQQNT 目录" 指定；\n` +
                    `      若只想产出通用包（运行时由环境变量 LQ_LOADER 或自动探测决定宿主），请加 --allow-missing-loader`
            );
        }
        console.warn("警告: 宿主目录不存在，继续构建通用产物 ——", loaderPath);
        console.warn("      该产物启动时按 LQ_LOADER 环境变量 / 常见安装位置自动寻找宿主。");
    }

    const base = resolveBaseManifest();
    const manifestData = { ...base.data };

    if (qqVersionOverride) manifestData.version = qqVersionOverride;
    if (buildVersionOverride) manifestData.buildVersion = buildVersionOverride;

    const manifest = {
        name: manifestData.name || "qq-chat",
        version: manifestData.version || "",
        private: true,
        description: manifestData.description || "QQ",
        productName: manifestData.productName || "QQ",
        author: manifestData.author,
        homepage: manifestData.homepage,
        sideEffects: manifestData.sideEffects !== undefined ? manifestData.sideEffects : true,
        bin: manifestData.bin,
        // 注入点：改为我们自己的入口
        main: "./app_launcher/index.js",
        buildVersion: manifestData.buildVersion,
        isPureShell: manifestData.isPureShell,
        isByteCodeShell: manifestData.isByteCodeShell,
        platform: manifestData.platform,
        eleArch: manifestData.eleArch,
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

    fs.mkdirSync(outDir, { recursive: true });
    clean(OUT);
    await asar.createPackage(staging, OUT);
    fs.rmSync(staging, { recursive: true, force: true });

    const size = fs.statSync(OUT).size;
    const files = asar.listPackage(OUT);

    const info = {
        builtAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        loader: {
            path: loaderPath,
            exists: loaderExists,
            mode: loaderExists ? "构建时固定" : "运行时探测 (LQ_LOADER / 常见位置)",
        },
        qq: {
            dir: qqDir,
            manifestSource: base.source,
            name: manifest.name,
            version: manifest.version || null,
            buildVersion: manifest.buildVersion || null,
        },
        artifact: {
            file: "app.asar",
            size,
            sha256: sha256(OUT),
            files,
        },
    };
    fs.writeFileSync(INFO, JSON.stringify(info, null, 2) + "\n", "utf8");

    console.log("已生成:", OUT, `(${size} 字节)`);
    console.log("清单来源:", base.source);
    console.log("QQ 版本:", manifest.version || "(未设置)", "build:", manifest.buildVersion || "-");
    console.log("宿主路径:", loaderPath, loaderExists ? "(存在)" : "(不存在 → 运行时探测)");
    console.log("构建信息:", INFO);
    console.log("包内文件:");
    for (const item of files) console.log("  " + item);
    console.log("\n下一步: node install.js    # 部署到 QQ 并在必要时重启验证");
}

build().catch((err) => {
    clean(path.join(ROOT, ".staging"));
    console.error("生成失败:", err && err.message ? err.message : err);
    process.exitCode = 1;
});
