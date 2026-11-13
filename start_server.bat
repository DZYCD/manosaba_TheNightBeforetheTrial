@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PORT=8392"
echo 启动魔法少女的审判前夜本地服务器...
echo 访问地址: http://localhost:%PORT%
echo 按 Ctrl+C 停止服务器
echo.

where node >nul 2>nul
if not errorlevel 1 goto use_node
where py >nul 2>nul
if not errorlevel 1 goto use_py
where python >nul 2>nul
if not errorlevel 1 goto use_python

echo 未找到 Node.js 或 Python，无法启动本地服务器。
echo 装任意一个即可：Node.js https://nodejs.org/  /  Python https://www.python.org/
echo.
pause
exit /b 1

:use_node
node "%~dp0serve.js" %PORT%
goto done

:use_py
py -3 -m http.server %PORT%
goto done

:use_python
python -m http.server %PORT%

:done
echo.
echo 服务器已停止。
pause
