# 部署到 ModelScope 创空间（Docker 版）

本文档对应「本地已跑通、要公开上线」的场景。目标：用你现成的 ModelScope 账号，
把 `ziwei-doushu` 以 Docker 创空间的形式跑起来，同时代码同步到你自己的 GitHub。

> 为什么不能选「静态/应用」类型：本项目有服务端接口 `app/api/interpret/route.ts`，
> 需要 Node 运行时，只有 **Docker 类型**的创空间能跑。

---

## 0. 上线前检查清单

- [ ] 本地 `npm run dev` 能正常排盘 + 流式出解读
- [ ] `.env.local` 里 `DEEPSEEK_API_KEY` 有效
- [ ] `git status` 里**看不到** `.env.local`（`.gitignore` 已忽略 `.env*`）
- [ ] 决定是否开启 `ACCESS_CODE`（公开站建议开）

---

## 1. 同步到你自己的 GitHub

当前仓库的 `origin` 指向原作者仓库（`Renhuai123/ziwei-doushu`），直接 push 会被拒。

```bash
cd D:\dsh\ziweimingpan\try\ziwei-doushu

# 1) 确认敏感文件没被跟踪
git status

# 2) 上游改名，保留后续同步原作者更新的能力
git remote rename origin upstream

# 3) 在 GitHub 网页新建空仓库（不要勾选 README / .gitignore / License）
git remote add origin https://github.com/<你的用户名>/ziwei-doushu.git

# 4) 建议在新分支上提交
git checkout -b deploy-modelscope
git add -A
git commit -m "feat: 本地 DeepSeek 流式解读 + 解读面板优化 + ModelScope 部署文件"
git push -u origin deploy-modelscope
```

合规提示（重要）：

- 代码是 **MIT**：可以自由改、自由分发，但**必须保留原作者的 LICENSE 与版权声明**，README 里加一句
  “Forked from https://github.com/Renhuai123/ziwei-doushu”。
- `docs/tianji-ziwei/`（倪师原话）是 **CC BY-NC-SA 4.0**：**不可商用**。所以这个站不能挂广告、不能收费。
- 数据集是 **CC BY 4.0**：使用时要署名。

---

## 2. 在 ModelScope 创建 Docker 创空间

1. 打开 https://modelscope.cn/ → 创空间（Studio）→ **新建创空间**
2. 类型选 **Docker**（不是 Gradio / Streamlit / 静态）
3. 仓库来源：关联上面推送的 GitHub 仓库（或按平台引导把代码传上去）
4. 空间可见性：免费额度要求**公开**
5. 创建后进入「设置 → 环境变量」，填写：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 是 | 你的 Key |
| `AI_PROVIDER` | 是 | `deepseek` |
| `NEXT_PUBLIC_SITE_URL` | 推荐 | 空间访问地址，如 `https://modelscope.cn/studios/LanMercer/ziwei` |
| `ACCESS_CODE` | 推荐 | 访问口令，不设则任何人可用 |
| `RATE_PER_MINUTE` | 否 | 每 IP 每分钟次数，默认 3 |
| `RATE_PER_DAY_IP` | 否 | 每 IP 每天次数，默认 30 |
| `RATE_PER_DAY_GLOBAL` | 否 | 全站每天次数，默认 400 |

不要把这些写进 Dockerfile 或代码里——一律走环境变量。

6. 保存后触发构建，等待镜像 build 完成。

> 若创建向导里要求填「应用端口 / app_port」，一律填 **7860**。
> 若平台提示需要 README 头部配置（部分版本要求），在仓库 `README.md` 最上方加：
>
> ```yaml
> ---
> sdk: docker
> app_port: 7860
> ---
> ```
>
> 不确定时以创建页面的提示为准——不同时期的 ModelScope 控制台字段略有差异。

---

## 3. 端口必须 7860（最容易踩的坑）

ModelScope 创空间只把 **7860** 端口暴露出去。如果应用监听别的端口（比如默认 3000），
页面会一直重定向、打不开，日志里能看到服务其实起来了。

本项目已经带好 `Dockerfile`，关键两行：

```dockerfile
ENV PORT=7860
CMD ["npx", "next", "start", "-p", "7860", "-H", "0.0.0.0"]
```

如果你改端口，记得 `EXPOSE` 和 `CMD` 两处一起改。

---

## 4. 访问

构建完成后访问：

```
https://modelscope.cn/studios/LanMercer/<空间名>
```

首次访问可能冷启动 30–60 秒（免费实例闲置会休眠），属正常现象。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 页面空白或疯狂跳转 | 没监听 7860；检查 `Dockerfile` 的 `PORT`/`CMD` |
| 点解读提示「还没有配置 API Key」 | 环境变量没加，或改完没**重新构建/重启**（Next 只在启动时读 env） |
| 提示 401 / 需要口令 | 空间设了 `ACCESS_CODE`，在解读面板底部输入口令即可 |
| 提示余额不足 / Key 无效 | DeepSeek 控制台充值或换 Key（401=Key 错，402=余额不足） |
| 提示「问得有点快」 | 触发限流，等一分钟或调大 `RATE_PER_MINUTE` |
| 首次打开很慢 | 免费实例休眠后冷启动，正常 |

---

## 6. 上线后的安全习惯

1. **Key 只在服务端**：现在浏览器拿不到 Key，所有请求都在 `/api/interpret` 里转发。
2. **开口令 + 限流**：公开链接一定会被转发，没限流就是给别人刷你的额度。
3. **看额度**：定期去 DeepSeek 控制台看用量，异常就换 Key + 清缓存。
4. **不要提交 `.env.local`**：`.gitignore` 已覆盖，但每次 commit 前 `git status` 确认一遍。
5. **隐私声明**：页面底部已注明「命盘仅用于本次生成，服务器不保存」；如果要收集任何用户数据，请另行说明。

---

## 7. 后续更新

```bash
git add -A
git commit -m "chore: ..."
git push
```

然后在 ModelScope 空间里点「重新构建」（部分配置支持 push 自动构建）。
注意：只改环境变量不会自动生效，需要重启/重建容器。
