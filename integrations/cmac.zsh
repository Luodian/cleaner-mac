# cleaner-mac stats in the zsh prompt.
#   source "$(npm root -g)/cleaner-mac/integrations/cmac.zsh"     # in ~/.zshrc
# The prompt never waits: each prompt starts `cmac stats --line` in the background and shows the
# line the previous one wrote, so the numbers are one prompt old. Works the same inside tmux,
# herdr, or any other terminal that runs zsh.
# Put $CMAC_STATS wherever you like; by default it goes on the right-hand side.

typeset -g CMAC_STATS=""
typeset -g _cmac_line_file="${XDG_CACHE_HOME:-$HOME/.cache}/cleaner-mac/line"

_cmac_precmd() {
  [[ -r $_cmac_line_file ]] && CMAC_STATS="$(<$_cmac_line_file)"
  (cmac stats --line >/dev/null 2>&1 &)
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _cmac_precmd
setopt prompt_subst
[[ -z ${CMAC_NO_RPROMPT:-} ]] && RPROMPT='%F{244}${CMAC_STATS}%f'
