# DSH LAN Sync

[中文使用教程](docs/SYNC.md) · [Protocol](docs/DETAIL.md) · [DSH Fleet](https://github.com/yzq0314/dsh-fleet)

Keep selected DSH Desktop plugins and portable preferences consistent across computers. Preview differences before applying a selection on the destination. Select one plugin, repeat the selection for a batch, or use the entire source manifest.

## Install from this repository

Use a compatible DSH Desktop runtime (>= 0.2.2-rc.1 and < 0.3.0) and Node.js 20 or newer with npm. From the repository root:

```sh
npm pack --ignore-scripts
dsh plugin --profile desktop add --prefer-offline --ignore-scripts ./dsh-lan-sync-0.2.0.tgz
```

Save your work and quit Desktop before running the second command. Reopen Desktop to load the plugin. Use the installed DSH command for the desktop profile you intend to update.

## Try a plugin sync

Run the Python helper from this checkout with Python 3.10+ and the dependencies in `requirements.txt` (for example `python -m pip install -r requirements.txt` inside a virtual environment).

1. On the source, run `python lib/profile_sync.py export --file desktop-plugin-selection.json`.
2. Transfer that file privately to the destination computer. Run `python lib/profile_sync.py preview --file desktop-plugin-selection.json --only dsh-context` and review the version and settings counts.
3. Save work and quit Desktop on the destination. Use `python lib/profile_sync.py apply --file desktop-plugin-selection.json --only dsh-context`. Reopen Desktop and check the enabled plugin. Repeat `--only` to select multiple plugins, or omit it to process the whole selection.

The helper backs up profile settings under `DSH_HOME/lan-sync/apply-*`. Locally installed packages may require their original installer. The portable settings cover selected UI preferences, startup animation settings and plugin market indexes. Manifests can contain personal display text. Keep them between your devices.

Fleet users can retrieve the source manifest from a node's inbox using `--from-node`. Pairing the optional LAN listener is a separate way to exchange package inventories. See the [sync guide](docs/SYNC.md) and [listener reference](docs/DETAIL.md).

## Development

```sh
node test/smoke-pure.mjs
python -m unittest discover -s test -p "test_*.py"
```

Released under the [MIT License](LICENSE).
