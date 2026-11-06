/**
 * 部署 / 卸载 app.asar 注入。
 *
 * 注入点：QQNT\versions\<版本>\resources\app.asar
 *   Electron 在处理资源目录时会优先加载 app.asar 作为应用根目录，
 *   而 <版本>\resources\app 保持原样 —— 因此 QQ 的完整性校验
 *   （application.json 里的签名摘要）依然能通过，QQ 正常启动。
 *
 * 项目内另有 application/background.js 转发文件：QQ 原生启动器会按
 * app.getAppPath() 去找 <appPath>/application/background.js，
 * 该文件把它转回真正的 application.asar，避免 QQ 报模块缺失后退出。
 *
 * 用法：
 *   node install.js            # 部署（自动备份）
 *   node install.js --status   # 查看状态
 *   node install.js --restore  # 卸载，恢复原生
 */

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const ROOT = __dirname;
const SRC_ASAR = path.join(ROOT, "app.asar");
const BACKUP_DIR = path.join(ROOT, "backup");
const DEFAULT_QQ = String.raw`D:\App\QQ`;

function arg(name) {
    const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
}

const qqDir = path.resolve(arg("qq") || process.env.LQ_QQ_DIR || DEFAULT_QQ);

function resolvePaths() {
    const versionsDir = path.join(qqDir, "versions");
    if (!fs.existsSync(versionsDir)) throw new Error(`找不到版本目录: ${versionsDir}`);

    let version = "";
    try {
        const config = JSON.parse(fs.readFileSync(path.join(versionsDir, "config.json"), "utf8"));
        version = config.curVersion || config.baseVersion || "";
    } catch {
        /* 忽略，退回目录扫描 */
    }
    if (!version) {
        version = fs
            .readdirSync(versionsDir, { withFileTypes: true })
            .filter((item) => item.isDirectory())
            .map((item) => item.name)
            .sort()
            .pop();
    }

    const resources = path.join(versionsDir, version, "resources");
    const appDir = path.join(resources, "app");
    if (!fs.existsSync(appDir)) throw new Error(`找不到 resources/app: ${appDir}`);

    return {
        version,
        resources,
        appDir,
        target: path.join(resources, "app.asar"),
        manifest: path.join(appDir, "package.json"),
    };
}

function qqRunning() {
    try {
        const out = require("node:child_process").execSync('tasklist /FI "IMAGENAME eq QQ.exe" /NH', {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return /QQ\.exe/i.test(out);
    } catch {
        return false;
    }
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function status() {
    const { version, appDir, target, manifest } = resolvePaths();
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    console.log("QQ 版本:", version);
    console.log("原生入口 main:", pkg.main, pkg.main === "./application.asar/app_launcher/index.js" ? "(未改动)" : "(已被改动！)");
    console.log("应用目录:", appDir);

    if (!fs.existsSync(target)) {
        console.log("注入状态: 未注入");
        return;
    }
    console.log("注入状态: 已注入");
    console.log("app.asar:", target, `(${fs.statSync(target).size} 字节)`);
    try {
        const files = asar.listPackage(target);
        console.log("包内文件:", files.join(", "));
        if (!files.some((f) => f.endsWith("application\\background.js"))) {
            console.log("警告: 缺少 application/background.js 转发文件，QQ 可能无法启动");
        }
    } catch (err) {
        console.log("app.asar 无法解析:", err.message);
    }
}

function install() {
    if (!fs.existsSync(SRC_ASAR)) throw new Error(`缺少产物 ${SRC_ASAR}，请先执行 node build-asar.js`);
    const { target, manifest } = resolvePaths();
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));

    if (pkg.main !== "./application.asar/app_launcher/index.js") {
        console.log("警告: resources/app/package.json 的 main 已被改动（当前:", pkg.main, "）");
        console.log("      QQ 会因完整性校验失败而静默退出，请先还原为 ./application.asar/app_launcher/index.js");
    }
    if (qqRunning()) {
        console.log("提示: QQ 正在运行，建议先退出，否则文件可能被占用。");
    }

    if (fs.existsSync(target)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const backup = path.join(BACKUP_DIR, `app.asar.${stamp()}.bak`);
        fs.copyFileSync(target, backup);
        console.log("已备份旧 app.asar ->", backup);
    }

    fs.copyFileSync(SRC_ASAR, target);
    console.log("已部署 ->", target, `(${fs.statSync(target).size} 字节)`);
    console.log("resources/app 未做任何改动，QQ 的文件校验不受影响。");
    console.log("\n完成。退出并重新启动 QQ 生效。");
}

function restore() {
    const { target } = resolvePaths();
    if (!fs.existsSync(target)) {
        console.log("未发现 resources/app.asar，QQ 已是原生状态。");
        return;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `app.asar.${stamp()}.bak`);
    fs.copyFileSync(target, backup);
    fs.rmSync(target, { force: true });
    console.log("已移除 resources/app.asar（备份于", backup, "）");
    console.log("QQ 恢复原生启动。");
}

try {
    if (process.argv.includes("--status")) status();
    else if (process.argv.includes("--restore")) restore();
    else install();
} catch (err) {
    console.error("操作失败:", err.message);
    process.exitCode = 1;
}
