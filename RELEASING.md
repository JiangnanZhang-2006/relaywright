# 发布

维护者在 `main` 上手工发布。不发布到 npm，也不靠 workflow 自动建 Release。

0.x 只发布 `main` 上的最新版本，与 [SECURITY.md](SECURITY.md) 一致。

## 版本号

版本号以 `package.json` 的 `version` 为准，遵循[语义化版本](https://semver.org/lang/zh-CN/)。同一次提交里还要改：

- `package-lock.json` 根上的两处 `version`
- `README.md` 与 `README.en.md` 里「项目处于 …」那一句
- `CHANGELOG.md`：把 `## [未发布]` 下的内容移到 `## [x.y.z] - YYYY-MM-DD`，并留下空的 `## [未发布]`。格式见 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)

不要改 `bench/agent.ts` 里的客户端版本。

版本号里有预发布标识（例如 `0.1.0-rc.1`）时，GitHub Release 勾选 Pre-release。没有预发布标识就是正式 Release。不规定 alpha、beta、rc 的先后，也可以直接发正式版。

## 步骤

1. 在 `main` 上提交版本改动。提交信息：`chore: release x.y.z`。
2. `git push origin main`。
3. 等该提交的 GitHub Actions 全绿。检查包括类型检查、构建、单元测试和许可证检查。失败就修，不打标签、不建 Release。发布前不要求在本机再跑 `npm test` 或 `npm run test:e2e`。
4. 在该提交上打附注标签。标签名是 `v` 加上 `package.json` 里的版本号：

```bash
git tag -a vx.y.z -m "x.y.z"
git push origin vx.y.z
```

已经推送的标签不移动、不删除。

5. 建 GitHub Release。标题用标签名，正文用变更记录里该版本的那一节。有预发布标识时加上 `--prerelease`：

```bash
gh release create vx.y.z --title "vx.y.z" --prerelease --notes-file /dev/stdin <<'EOF'
（粘贴 CHANGELOG 里该版本的一节）
EOF
```

正式版去掉 `--prerelease`。
