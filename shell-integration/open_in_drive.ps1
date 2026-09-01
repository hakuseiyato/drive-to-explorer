# Open the given local path in Google Drive Web.
# Constructs https://drive.google.com/drive/u/0/#dte_resolve=<encoded path>
# and launches it via Start-Process (uses default browser).
#
# Invoked from Explorer right-click via the registry entry installed by
# install_shell.bat.

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Path
)

if (-not $Path -or $Path.Trim() -eq "") {
    exit 1
}

$encoded = [uri]::EscapeDataString($Path)
$url = "https://drive.google.com/drive/u/0/#dte_resolve=$encoded"

Start-Process $url
