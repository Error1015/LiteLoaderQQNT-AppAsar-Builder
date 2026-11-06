# LiteLoaderQQNT-AppAsar-Builder

为 QQNT（Windows）生成一份**注入式 `app.asar`**，让 QQ 启动时先拉起 LiteLoaderQQNT 宿主，再由宿主加载插件。

不看源码就能用：本地改路径靠参数 / 配置文件，不想本地构建就用 GitHub Actions 出的 Release 包。

---

## 一、原理（为什么这样做）

QQNT 启动前会校验 `QQ\versions\<版本>\resources\app\` 下的 `application.json`（内含 `application.asar`、`wrapper.node`、`major.node`、`package.json` 的签名摘要）。**只要动了 `resources\app` 里的文件，校验就失败，QQ 静默退出（控制台 `error code v2:-1`）。**

但 Electron 在确定应用根目录时**优先使用 `resources\app.asar`**（它存在时整个 `resources\app` 目录会被忽略）。于是本项目：

- 只新增/替换 `resources\app.asar` 这一个文件；
- `resources\app` 完全不动 → 完整性校验照常通过，QQ 正常启动；
- `app.asar` 里的 `app_launcher/index.js` 先 `require` 宿主，宿主自己会拉起 QQ 本体入口；
- 包里额外放一个 `application/background.js` 转发壳，把 QQ 原生启动器对 `<appPath>/application/background.js` 的请求转回真正的 `application.asar`，避免 `Cannot find module`。

```
versions\<ver>\resources\
├── app\                    # QQ 原生，绝不修改
│   ├── application.json    #   签名清单
│   ├── application.asar    #   本体（逐文件加密，不可重打包）
│   └── package.json        #   main = ./application.asar/app_launcher/index.js
└── app.asar                # ← 本项目产物（注入点）
```

## 二、快速开始（本地）

```bash
git clone https://github.com/Error1015/LiteLoaderQQNT-AppAsar-Builder.git
cd LiteLoaderQQNT-AppAsar-Builder

# 1. 安装依赖。务必带 --ignore-scripts（历史上 install 钩子会直接往本机 QQ 部署）
npm install --ignore-scripts

# 2. 构建：把路径换成你自己的
node build-asar.js --loader="D:/App/LiteLoaderQQNT" --qq="D:/App/QQ"

# 3. 退出 QQ 后部署（自动备份旧 app.asar 到 backup/）
node install.js --qq="D:/App/QQ"

# 4. 启动 QQ，日志里应出现 [LQ-Inject] 宿主已加载: ...
```

要求：Windows + 已安装 QQNT + 已安装 LiteLoaderQQNT 宿主 + Node.js ≥ 18。

## 三、自定义 LiteLoaderQQNT 路径

四种方式，优先级从高到低，**都不需要改代码**：

### 1. 命令行参数

```bash
node build-asar.js --loader="F:/Tools/LiteLoaderQQNT" --qq="F:/QQ"
```

### 2. 环境变量

```bash
# PowerShell
$env:LQ_LOADER="F:/Tools/LiteLoaderQQNT"; $env:LQ_QQ_DIR="F:/QQ"; node build-asar.js
# CMD
set LQ_LOADER=F:\Tools\LiteLoaderQQNT && node build-asar.js
```

### 3. 项目配置文件（推荐，一次配置长期有效）

复制 `.lqrc.example.json` 为 `.lqrc.json`（该文件已被 gitignore），改成自己的路径：

```json
{
  "loader": "F:/Tools/LiteLoaderQQNT",
  "qq": "F:/QQ"
}
```

之后 `node build-asar.js` 与 `node install.js` 都直接生效。

### 4. 运行时覆盖（给"别人"用，不用重新构建）

产物里宿主路径有两层保障：

1. 启动时优先读环境变量 **`LQ_LOADER`**；
2. 没设就自动探测常见位置：`<QQ安装目录>/LiteLoaderQQNT`、`<QQ安装目录同级>/LiteLoaderQQNT`、`resources/LiteLoaderQQNT`、`%APPDATA%\LiteLoaderQQNT`、`%LOCALAPPDATA%\LiteLoaderQQNT`、`C:\LiteLoaderQQNT`、`D:\LiteLoaderQQNT`；
3. 最后才用构建时写死的路径。

所以**一份通用产物可以发给宿主装在任意位置的人**，对方只需：

```powershell
setx LQ_LOADER "F:\Tools\LiteLoaderQQNT"   # 设一次，之后一直有效
```

宿主加载失败时不会让 QQ 崩，会自动回退到原生启动，日志见 `[LQ-Inject]`。

## 四、GitHub Actions 构建 + 自动发布 Release
工作流：[`.github/workflows/build.yml`](.github/workflows/build.yml)

1. Fork 此仓库
2. 进入`Actions`，点击`Workflows\build-app-asar`
3. 点击Run workflow，传入本地的`LiteloaderQQNT`目录，`QQNT`的版本号，构建版本号
4. 运行完毕后会自动上传到release，或者在` Artifacts `可以找到产物。


### 触发方式

| 方式 | 行为 |
|---|---|
| push tag（`v*`） | 构建 → 上传产物 → 自动创建 Release，附件名带 `v<构建器版本>-qq<QQ版本>` |
| 手动 Run workflow | 只构建 + 上传 artifact（30 天），可临时指定宿主路径与 QQ 版本 |

### 发版

```bash
# 先把 package.json 的 version 改成与 tag 一致（附件文件名取自它）
git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
```

仓库 Release 页会自动出现
`LiteLoaderQQNT-AppAsar-Builder-v1.0.1-qq9.9.37-54395.zip`（含 `app.asar` + `build-info.json`）。
前半段 `v1.0.1` 是构建器版本（= tag = `package.json` 的 `version`），后半段 `qq9.9.37-54395` 是这份包面向的 QQ 版本，两者都不需要手工拼。

### 用 Repository variables 定制默认宿主路径

无需改 workflow，在 `Settings → Secrets and variables → Actions → Variables` 添加：

| 变量 | 说明 | 示例 |
|---|---|---|
| `LQ_LOADER_PATH` | 写进产物的宿主目录 | `D:/App/LiteLoaderQQNT` |
| `LQ_QQ_VERSION` | 覆盖清单版本号 | `9.9.37-54395` |
| `LQ_BUILD_VERSION` | 覆盖 buildVersion | `54395` |

CI 里自动加 `--allow-missing-loader`：构建机上没有 QQ/宿主也能出包，此时产物的 `build-info.json` 会标注 `"mode": "运行时探测"`。

> CI 安装依赖固定用 `npm ci --ignore-scripts`。npm 会把 `package.json` 的 `install` 脚本当作生命周期钩子执行，本项目已把它改名为 `deploy`，避免误触发本机部署。

## 五、命令速查

| 命令 | 作用 |
|---|---|
| `node build-asar.js` | 生成 `./app.asar`（+ `build-info.json`） |
| `node build-asar.js --loader=... --out=dist` | 指定宿主路径、输出到 `dist/` |
| `node build-asar.js --allow-missing-loader` | 宿主不在本机也构建（通用包/CI 模式） |
| `node build-asar.js --qq-version=9.9.37-54395` | 覆盖清单版本号 |
| `node install.js --qq=...` | 部署到 QQ（覆盖前自动备份） |
| `node install.js --status --qq=...` | 查看注入状态、包内文件、`main` 是否被改坏 |
| `node install.js --restore --qq=...` | 卸载，恢复 QQ 原生启动 |
| `npm run build` / `deploy` / `status` / `restore` | 上述命令的 npm 别名（默认路径） |

## 六、产物说明与版本溯源

每个 Release 的产物都带**双重版本号**，文件名形如：

```
LiteLoaderQQNT-AppAsar-Builder-v1.0.1-qq9.9.37-54395.zip
                              ^构建器版本    ^目标 QQ 版本
```

`-qq` 后面的版本来自构建时读取的 QQ 清单，可用 `--qq-version=` 覆盖。这样下载多个 Release 放进同一个文件夹也不会混淆。

`build-info.json`（随 zip 一起发布）：

```json
{
  "builder": { "name": "LiteLoaderQQNT-AppAsar-Builder", "version": "1.0.1", "commit": "dae682e", "ref": "v1.0.1", "ci": true },
  "builtAt": "2026-11-07T...",
  "suggestedFileName": "LiteLoaderQQNT-AppAsar-Builder-v1.0.1-qq9.9.37-54395.zip",
  "loader": { "path": "C:/LiteLoaderQQNT", "exists": false, "mode": "运行时探测 (LQ_LOADER / 常见位置)" },
  "qq": { "manifestSource": "内置基线清单 (未找到本地 QQ)", "version": "9.9.37-54395", "buildVersion": "54395" },
  "artifact": { "file": "app.asar", "size": 7222, "sha256": "...", "files": ["..."] }
}
```

`app.asar` 内部结构（比早期版本多一个 `lq-build.json`，纯元数据，不影响 QQ 启动）：

```
package.json               # main: ./app_launcher/index.js（version 仍是 QQ 的，勿改）
lq-build.json              # 构建器版本 / commit / 目标 QQ 版本 / 宿主模式
app_launcher/index.js      # 宿主加载 + 本体入口兜底
application/background.js  # 转发到原生 application.asar
```

这样即使 `app.asar` 被单独拷走，也能追出它由哪个版本、哪个 commit 构建、面向哪个 QQ 版本。部署后随时查回：

```bash
node install.js --status

# QQ 版本: 9.9.37-54395
# 注入状态: 已注入
# 构建器: LiteLoaderQQNT-AppAsar-Builder 1.0.1 commit dae682e
# 构建时间: 2026-11-07T...
# 产物目标 QQ: 9.9.37-54395 (与本机一致)
# 宿主模式: 构建时固定
```

旧版产物（没有 `lq-build.json`）会提示「包内无 lq-build.json（旧版产物，无法溯源版本）」。

> `package.json` 里的 `version` 必须保持 QQ 自己的版本号（如 `9.9.37-54395`），它会影响 QQ 内部版本判断；构建器版本只写在 `lq-build.json` 和 `build-info.json` 里。

## 七、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| QQ 完全没反应、控制台 `error code v2:-1` | `resources\app` 被改过 → 恢复原 `package.json`（`main` 必须是 `./application.asar/app_launcher/index.js`）与 `application.json`，备份在 `backup/` |
| QQ 能开但插件没生效 | 宿主路径不对。看日志 `[LQ-Inject]`；设 `LQ_LOADER` 指向真实宿主目录 |
| `Cannot find module ...application/background.js` | 产物里缺转发壳，确认用的是本项目的 `app.asar`，不要用旧版包 |
| QQ 升级后注入失效 | 自更新会重建 `versions\<新版本>\`。重新 `node build-asar.js` + `node install.js`，必要时更新版本号 |
| 想立刻回到原生 | 设环境变量 `LQ_INJECT_DISABLE=1` 启动；或 `node install.js --restore` |
| 部署报文件占用 | 退干净 QQ（含托盘）再执行 |

## 八、目录结构

```
build-asar.js                 # 构建：生成 app.asar（支持 --loader/--qq/--out/--allow-missing-loader 等）
install.js                    # 部署 / --status / --restore
src/app_launcher/index.js     # 注入入口（宿主加载 + 兜底）
src/application/background.js # 主进程转发壳
.github/workflows/build.yml   # CI：构建 + 自动 Release
.lqrc.example.json            # 本地路径配置示例
backup/                       # 部署时的备份（application.json.bak 是修完整性校验的凭据，勿删）
```

## 九、如何使用
1. 把构建产物压缩包解压缩，得到`app.asar`和`build-info.json`，
2. 将`app.asar`放入`QQNT`的目录`QQNT\versions\版本号\resources`，与`app`文件夹同目录
3. 重新启动`QQNT`，确认插件安装成功。

## 免责声明

仅供学习与个人使用。修改 QQ 客户端可能违反其服务条款，风险自负；操作前请确保 `backup/` 中的原生文件完整。
