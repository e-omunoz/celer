# Development environment: Rust (GNU) + MinGW-w64 + IBM CLI driver
$mingw = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'BrechtSanders.WinLibs*' | Select-Object -First 1
$env:PATH = "$env:USERPROFILE\.cargo\bin;$($mingw.FullName)\mingw64\bin;C:\dev\tools\clidriver\bin;$env:PATH"
