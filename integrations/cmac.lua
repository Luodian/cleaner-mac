-- cleaner-mac stats in the Neovim status line (Neovim 0.10 or newer).
-- Copy this file to ~/.config/nvim/lua/cmac.lua, then:
--
--   require('cmac').setup()                                  -- refreshes every 5 s, never blocks
--   vim.o.statusline = vim.o.statusline .. " %{v:lua.require'cmac'.status()}"
--
-- With lualine:  sections = { lualine_x = { require('cmac').status } }
local M = { line = '' }

local function refresh()
  vim.system({ 'cmac', 'stats', '--line' }, { text = true }, function(res)
    if res.code == 0 and res.stdout then
      M.line = vim.trim(res.stdout)
      vim.schedule(function() vim.cmd.redrawstatus() end)
    end
  end)
end

function M.setup(opts)
  if vim.fn.executable('cmac') == 0 then
    vim.notify('cmac is not on PATH: npm install -g cleaner-mac', vim.log.levels.WARN)
    return
  end
  local every = ((opts or {}).interval or 5) * 1000
  M.timer = vim.uv.new_timer()
  M.timer:start(0, every, refresh)
end

function M.status()
  return M.line
end

return M
