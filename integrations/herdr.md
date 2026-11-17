# cleaner-mac stats in herdr's sidebar

herdr shows display-only workspace metadata as a token in its sidebar.

1. In `~/.config/herdr/config.toml`, add the token to a sidebar row:

   ```toml
   [ui.sidebar.spaces]
   rows = [
     ["state_icon", "workspace"],
     ["branch", "git_status"],
     [{ token = "cmac" }],
   ]
   ```

   Then `herdr server reload-config`.

2. Keep the token fresh. It expires after 30 s, so report more often than that:

   ```bash
   cmac stats --herdr --watch 10 &
   ```

   Start it from `~/.zshrc`, a launchd agent, or a herdr plugin's `startup` command.

Panes in herdr run your shell, so the zsh integration (`cmac integration zsh`) also works there without any of this.
