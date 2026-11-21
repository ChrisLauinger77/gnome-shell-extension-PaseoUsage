# gnome-shell-extension-PaseoUsage

<div align="center">

![Gnome Extensions Downloads](https://img.shields.io/gnome-extensions/dt/PaseoUsage@lauinger-clan.de) ![GNOME Shell](https://img.shields.io/badge/GNOME-49%20--%2051-blue?logo=gnome&logoColor=white) ![GitHub License](https://img.shields.io/github/license/ChrisLauinger77/gnome-shell-extension-PaseoUsage)

</div>

Gnome Shell Extension to visualize the plan usage of your coding agents as reported by the [Paseo](https://github.com/getpaseo/paseo) command line tool (`paseo usage --json`).

- Shows the summary limits (for example the 5 hour session and the weekly limit) of every provider directly in the panel.
- Choose the panel display: icon only, icon and percentages, or icon with small bars and percentages.
- The popup shows one card per provider (Claude, Codex, …) with plan, usage bars, reset times, credits and account.
- Shows when the usage was last refreshed successfully.
- Refreshes automatically in a configurable interval (0 – 60 minutes, 0 turns it off).
- Mouse buttons on the panel button:
  - Left click: show the usage.
  - Right click: refresh the usage (when the last refresh is older than one minute) and show it.
  - Middle click: open the preferences.
- `paseo` is always called asynchronously, GNOME Shell never blocks while waiting for it.

# Requirements

Install [Paseo](https://github.com/getpaseo/paseo) and make sure its daemon is running. You can test the command line tool manually:

```bash
paseo usage --json
```

The extension uses `/usr/local/bin/paseo` by default. A different location can be configured in the preferences.

### Download latest release

1. Download the zip file from the [release page](https://github.com/ChrisLauinger77/gnome-shell-extension-PaseoUsage/releases)
2. Install it with `gnome-extensions install --force PaseoUsage@lauinger-clan.de.shell-extension.zip`
3. Enable it with `gnome-extensions enable PaseoUsage@lauinger-clan.de`

### Install from source

Use the `main` branch.

```bash
git clone https://github.com/ChrisLauinger77/gnome-shell-extension-PaseoUsage.git
cd gnome-shell-extension-PaseoUsage
./paseousage.sh install
```

Now restart gnome-shell (log out and in again on Wayland).

# Contributing

Pull requests are welcome.

To update the translation files run
`./paseousage.sh translate` in the extensions directory after your code changes are finished. This will update the files in po folder.
Then [Poedit](https://poedit.net/download) can be used to translate the strings. poedit can also be used to create new localization files.

# Debugging

Logging can be enabled in settings.
Afterwards open a console and type:

journalctl -f -o cat /usr/bin/gnome-shell

You will see now the output in the console when the usage is refreshed.

# ✨️ Contributors

[![Contributors](https://contrib.rocks/image?repo=ChrisLauinger77/gnome-shell-extension-PaseoUsage)](https://github.com/ChrisLauinger77/gnome-shell-extension-PaseoUsage/graphs/contributors)

## Credits

- [Paseo](https://github.com/getpaseo/paseo) for the `paseo usage` command
