# Desktop 插件同步

用指定的 Fleet inbox 存放本机导出的清单。可运行 `python lib/sync_menu.py <inbox>` 交互选择源设备和插件，也可按下文直接运行命令。

在需要同步的电脑安装本插件，用带 PyYAML 的 Python 3.10+ 运行安装目录里的 `lib/profile_sync.py`。Windows Fleet 节点可以使用 Sidecar 已安装的 Python。全量操作覆盖源清单列出的包。目标机独有的功能插件保留，已知本机集成只核对，来源不明的本地包须用原安装包更新。

1. 在源电脑导出清单到它的 Fleet inbox。示例为 `python lib/profile_sync.py export --file <inbox>/desktop-plugin-selection.json`。插件配置变化后重新导出。
2. 在目标机设置私有环境变量 `FLEET_HUB_URL` 和 `FLEET_API_KEY` 后运行 `python lib/profile_sync.py preview --from-node <源节点别名>`。也可用 Fleet 文件页下载清单，然后把参数替换成 `--file <下载的文件>`。
3. 保存工作、退出目标机 Desktop，用 `apply` 替换 `preview` 并使用相同参数。重新打开 Desktop 核对实际加载。只同步一项时在两条命令末尾加入 `--only dsh-context`；重复该参数可以自选一批。整批同步省略该参数。
4. 当前实现同步安装版本、登记状态、启动动画设置、桌宠尺寸/交互偏好、上下文界面的展示设置以及市场源。Pocket 密码、Fleet 配对、会话及桌宠账户资料由各机管理。源清单包含启动动画自定义显示文字，仅在自己的设备间传递。

导入前会备份配置到目标机的 `DSH_HOME/lan-sync/apply-*`。更新中断时可按相同命令重试。返回码 2 表示有本地包需要原安装器。