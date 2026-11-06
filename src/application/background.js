/**
 * 当 resources/app.asar 被 Electron 当作应用根目录时，QQ 原生启动器会按
 * app.getAppPath() 拼接 <appPath>/application/background.js 来加载主进程主体代码。
 * 这个文件把该请求转发回真正的 application.asar，避免 QQ 因找不到模块而退出。
 */

const path = require("node:path");

const real = path.join(process.resourcesPath, "app", "application.asar", "background.js");

require(real);
