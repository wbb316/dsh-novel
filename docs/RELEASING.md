# 发版流程（自动发 npm）

本仓库的发版走 tag 驱动，不需要在本地跑发布命令。

| 工作流 | 触发条件 | 做什么 |
|---|---|---|
| [publish.yml](../.github/workflows/publish.yml) | 推 `v*.*.*` tag / Release 被发布 / 手动触发 | **校验包名归属** → tag/版本一致 → 幂等检查 → `npm test` → `npm publish --provenance --access public` |

> ⚠️ `publish.yml` **必须**自己监听 tag push，不能只挂 release 事件：建 Release 的那条流水线用的是仓库
> 自带的 `GITHUB_TOKEN`，而 GitHub 规定 **`GITHUB_TOKEN` 产生的事件不会再触发其他 workflow**（防止递归触发）。
> 保留 `release` 事件触发，是为了覆盖「人在 GitHub 界面上手动发布 Release」这条路径。

---

## 先说清楚：npm 上的 `dsh-novel` 不是这个仓库发的

| 项 | 值 |
|---|---|
| npm 上的 [`dsh-novel@0.1.1`](https://www.npmjs.com/package/dsh-novel) | 维护者 `harrisding`，仓库 `github.com/ddedook/dsh-novel` —— **另一个人、另一个插件** |
| 本仓库 | `package.json` 里也写着 `"name": "dsh-novel"`，但**从来没有发布过** |

核实命令（一条就够）：

```bash
npm view dsh-novel maintainers
# → harrisding <dinghao1029@gmail.com>
```

所以在**改包名之前**，这条流水线发不出去：推 tag 会在最后一步撞 npm 的 403，
而 npm 的报错**完全不会提**「名字被占了」这件事。`publish.yml` 里的「**校验包名归属**」这一步
就是为了把它提前成一句人能读懂的话——它会先 `npm whoami`，再看这个名字的维护者名单里有没有你。

后果也不只是「少个下载渠道」这么轻：因为 npm 上没有本仓库的包，**这个插件只能靠 `git` 源安装**。

`github:wbb316/dsh-novel` 这种 spec 要求目标机上 `git` 可用、**且 `git` 自己的网络配置是对的**：
`git` 读 `git config --global http.proxy`，而 `pnpm` 取 registry / tarball 时**不读它**。
两者读的不是同一份配置，所以「`git` 自己能连」**不等于**「`pnpm` 调 `git` 能连」。

> 本机有一段**被这个差异骗到**的记录，留着当反面教材：同一台机器上 `git ls-remote` 拿到了 HEAD sha，
> 而 `pnpm add github:…` 报 `ERR_PNPM_GIT_RESOLVE_FAILED` / `schannel: failed to receive handshake`。
> 当时据此得出「`git` 传输层脆弱」——**这个一般化结论是错的**。真正的原因是本机那两份网络配置指向了
> 一个没在听的本地代理；代理恢复后复测，同一个包在 **git 源和 tarball 源两条路上双双成功**。
> 教训：一次前后对照分不清「机制」和「时间差」。

⚠️ 另外记牢一条边界：**改成 tarball URL 只能绕开 `git` 二进制，绕不开 github.com 可达性**。
`pnpm` 解析 `github:` 也是从 `codeload.github.com` 取包的，所以 github 整体不可达时两条路都不通——
那时**只有 registry 可走**，也就是必须先解决下面那个改名问题。

---

## 怎么改名（发不了 npm 时的唯一出路）

`@wbb316/dsh-novel` 在 npm 上**还没被占用**，改名即可发布：

```bash
npm view @wbb316/dsh-novel version   # 报 E404 = 空着
```

改名要动**四处，一处都不能漏**（键名必须与包的 `name` 一致，否则装不上）：

| 位置 | 改成 |
|---|---|
| 本仓库 `package.json` 的 `name` | `"@wbb316/dsh-novel"` |
| 每个 profile `package.json` 的 `dependencies` 键 | `"@wbb316/dsh-novel"` |
| 每个 profile 的 `dsh.profile.bundles` 数组 | `"@wbb316/dsh-novel"` |
| 每个 profile 里那条 `link:` / `github:` 声明的键 | 同上 |

scoped 包**默认是私有的**，所以发布命令**必须**带 `--access public`（`publish.yml` 里已经带了）。
漏掉的话别人装不上，报 404——看起来像「包不存在」，很难查。

> 不改名就别推 tag：归属预检会直接失败。这一步是**故意**做得比 npm 的 403 更好读。

---

## 一次性配置：加 NPM_TOKEN

npm 发布需要凭据，而凭据**不放在代码里**，只放在 GitHub 的仓库 secret 里——它不会被写进日志，
也不会出现在 PR 中，任何人（包括帮你配环境的 AI）都不需要看到它的明文。

1. 打开 <https://www.npmjs.com/settings/~/tokens>，点绿色的 **Generate New Token**。
   新版界面**直接进入 `New Granular Access Token` 表单**，没有「Classic Token」入口了。按这样填：

   | 表单项 | 填什么 | 为什么 |
   |---|---|---|
   | Token name | 随便取，例如 `dsh-novel-ci` | 以后轮换时好认 |
   | Expiration | **90 days**（界面给的最长值，没有"永不过期"） | 到期后 CI 发布会失败，见下方「轮换」 |
   | **Bypass two-factor authentication (2FA)** | **勾上** | 不勾的话发布会要求手机验证码，无人值守的流水线会卡死 |
   | Packages and scopes → Permissions | **Read and write (publish and stage)**，并在下方包列表里**勾上这个包** | 选成 `stage only` **发不出去**（只能传暂存区），这是最容易选错的一项 |
   | Organizations | **No access** | 个人包用不到组织权限 |
   | Allowed IP ranges | **留空** | GitHub Actions 的出口 IP 每次都不一样，填了必然失败 |

   ⚠️ **顺序反了会卡住**：granular token 的包列表里只有**已经存在**的包，
   所以全新包在列表里根本找不到。正确顺序是「**先本地发一版，再来建 token**」——
   不是先建 token 再发。

2. 保存后**立刻复制** token（`npm_` 开头，只显示这一次，关掉页面就再也看不到）。
3. 打开 <https://github.com/wbb316/dsh-novel/settings/secrets/actions>，点 **New repository secret**：
   - Name 填 `NPM_TOKEN`（必须一字不差，工作流就是按这个名字取的）；
   - Secret 粘贴刚复制的 token，保存。

配好之后不需要改任何代码。

> **轮换**：Granular token 最长 90 天，到期后 `publish.yml` 会在发布那一步失败（报 401 / 权限错误）。
> 到时候回 token 页面删掉旧的、照上表重新生成一个，更新 `NPM_TOKEN` 即可——**不用改代码，也不用改版本号**。
> token 也**不要**贴进聊天、issue 或提交里：它等同密码；一旦怀疑泄露，立刻在 npm 页面吊销并重新生成。

> **没配会怎样？** `publish.yml` 里的 guard 会检测到 `NPM_TOKEN` 为空，**跳过** npm 发布并在运行摘要里留一条 notice——
> 工作流仍然是绿的。这样 fork 出去的人推 tag 不会因为缺少 secret 而红一片。

---

## 首次补发 0.13.0（tag 已经在远端，推不了了）

> **前置**：先完成上面的「怎么改名」。包名还是 `dsh-novel` 时，归属预检会拦下这次发布。

`v0.13.0` 这个 tag **早就推到 origin 了**，再推一次不会产生事件、流水线不会跑。所以第一次要手动补：

1. 先把本分支推上去（`publish.yml` 必须在**默认分支**上，Actions 界面才会出现这个工作流）：
   ```bash
   git push origin main
   ```
2. 打开 <https://github.com/wbb316/dsh-novel/actions/workflows/publish.yml> → **Run workflow**：
   - **tag 留空** ← 关键。留空时它检触发这次运行的分支（main），并且**跳过 tag/版本号一致性校验**
     （校验只在 ref 真的是 `v*` tag 时才做）；包版本取 main 上 `package.json` 的 `0.13.0`。
   - 若填 `v0.13.0`，它会去检那个 tag 的代码——**而那个 tag 里没有 `run-tests.mjs` 和 `scripts.test`**，
     `npm test` 会以「Missing script: test」失败。所以别填。
3. 跑完确认一下：
   ```bash
   npm view @wbb316/dsh-novel version        # 应该是 0.13.0
   npm view @wbb316/dsh-novel maintainers    # 应该是你自己
   ```

## 之后发新版本（正常路径）

```bash
# 1. 改版本号：package.json 的 "version"（tag 名必须与它一致）
# 2. 提交
git add -A
git commit -m "chore: 发布 v0.14.0"
# 3. 打 tag 并推送 —— 推 tag 就会自动发布
git tag -a v0.14.0 -m "v0.14.0"
git push origin main
git push origin v0.14.0
```

`publish.yml` 会先校验 **tag 名与 `package.json` 的 version 是否一致**——不一致直接失败并说明原因
（`tag 是 v0.14.0，但 package.json 的 version 是 0.13.0，拒绝发布`），避免把错的版本号发出去
（npm 上同一个版本号**不能覆盖重发**，这个防呆很值）。

另一道防呆是**幂等**：如果这个版本号在 npm 上已经存在，`publish.yml` 会打一条 notice 并**跳过发布**，
而不是红着脸去撞 npm 的 403。

## 测试闸门

发布前会跑 `npm test`，也就是 `run-tests.mjs` —— 它**先 cd 到包根目录**再逐个跑 `test-*.mjs`。

这条不是可选的洁癖：那些测试用的是**包根相对路径**（读 `lib/client.js`、`package.json`），
从别的目录直接 `node test-xxx.mjs` 会有 3 个文件报 `ENOENT` **假失败**（实测过）。
`run-tests.mjs` 把 cwd 钉死，所以本地和在 CI 上结果一致。

单独跑某一个：`node test-plot.mjs`（**必须在包根目录下**）。

## provenance（可验证的来源签名）

`npm publish --provenance` 会用 GitHub Actions 的 OIDC 身份给包签名：npm 页面上会出现
**Built and signed on GitHub Actions** 标记。这也是 `publish.yml` 里 `id-token: write` 权限的用途。

前提：仓库是**公开**的，且 `package.json` 里有 `repository` 字段——本仓库两者都满足。

## 发布内容包含什么

由 `package.json` 的 `files` 字段决定（不是 `.npmignore`）：`lib/`（8 个 js，**故意提交**，
用户不装 TypeScript 也能直接跑）、`cordis.patch.yml`、`README.md`、`LICENSE`。

注意 `test-*.mjs` 和 `run-tests.mjs` **不在**发布清单里——它们只在仓库里跑，不随包分发，
所以装完之后别指望在那个目录里 `npm test`。

发布前想先看清单，用：

```bash
npm pack --dry-run
```

## 本地手动发布（不走 CI，备选）

```bash
npm login --registry=https://registry.npmjs.org
npm test
npm publish --registry=https://registry.npmjs.org --access public
```

本机配了国内镜像源（本机 `.npmrc` 是 `registry=https://mirrors.huaweicloud.com/repository/npm/`），
发布前**务必显式指定官方源**，否则会推到镜像上（镜像只读，会失败或报权限错误）。`npm login` 和
`npm publish` 两条命令都要带 `--registry`。

> 这也是**首次发布更省事的那条路**：本地发完，包就存在了，granular token 的包列表里才有它可选。
