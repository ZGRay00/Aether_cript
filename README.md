# Aether Console · 自动助手

用于 Aether 的油猴脚本，支持日常、地下城探索、背包管理及按角色保存配置。

## 安装与更新

- [安装最新版本（GitHub Raw）](https://raw.githubusercontent.com/ZGRay00/Aether_cript/main/aether-auto-helper.user.js)
- [备用安装地址（jsDelivr）](https://cdn.jsdelivr.net/gh/ZGRay00/Aether_cript@main/aether-auto-helper.user.js)
- [使用说明](./Aether助手-v2使用说明.md)

已安装旧版时，先从上述地址覆盖安装一次。之后在面板顶部点击「检查更新」。与红叶镇助手使用相同机制：并行检查 GitHub Raw 和三个 jsDelivr 源，校验名称、命名空间及版本，选择最高版本并打开油猴确认页。允许弹窗，确认安装后刷新游戏页面；原角色配置保留。不会静默执行下载的代码。

## 维护与发布

`Aether自动助手.user.js` 是编辑源文件；`aether-auto-helper.user.js` 是固定发布入口，两者必须一致。

1. 修改源文件，同时递增 `@version` 与 `VERSION`，更新使用说明。
2. 执行 `node scripts/prepare-release.cjs`，同步英文发布入口并检查版本和语法。
3. 运行相关离线测试；浏览器测试使用独立 Chrome 调试实例（端口 9247），依次执行：

   ```sh
   node tests/aether-v2-ui.cjs
   node tests/aether-config-import.cjs
   node tests/aether-battle-timeout.cjs
   node tests/aether-updates.cjs
   ```

4. 将两个脚本、说明及相关测试一起提交并推送到本仓库 `main`。

GitHub Actions 会检查两个脚本一致、版本一致和 JavaScript 语法，并在发布入口变更后刷新 jsDelivr 缓存。CDN 可能延迟，面板同时查询 GitHub Raw，以避免单个缓存源影响版本判断。

离线测试仅使用模拟数据，不会操作真实游戏账号。
