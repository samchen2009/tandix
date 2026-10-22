# 开发时自动升版

运行 `pnpm install` 会通过根目录的 `prepare` 安装 Git 提交钩子；已有 checkout 也可运行 `pnpm hooks:install` 或 `node scripts/dev/version.mjs --install-hooks`。源码 ZIP 和非 Git 安装会跳过安装钩子。

- 普通 `git commit` 和 `git commit --amend` 自动递增 `0.x.y` 的 `y`，例如 `0.2.0 → 0.2.1 → 0.2.2`。
- `x` 由开发者手动调整：在根目录 `package.json` 中将版本改为 `0.3.0` 并暂存，提交时会保留该新起点；下一次提交变为 `0.3.1`。
- Chrome／Firefox 扩展清单、扩展 package、Codex 安装包及锁文件、Agent 桥接标识会同步更新并进入本次提交。
- 提交失败后重试不会重复递增。未暂存的其他修改会保留，不会被钩子一起暂存。
- 现有 `pre-push` 保持不变；已有 `pre-commit` 会保留并先执行。公开导出的 `commit-tree` 使用源提交中的版本，不额外递增。

版本更新后仍需重新构建扩展并在浏览器中重新加载，才能让已加载的扩展显示新版本。
