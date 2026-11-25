@echo off
rem [실사용 스크립트] 5 전용 Windows 예약 실행. KOSPI5_PYTHON 으로 Python 경로 지정.
cd /d "%~dp0.."
if errorlevel 1 exit /b 1
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
if not defined KOSPI5_PYTHON if exist ".venv\Scripts\python.exe" set "KOSPI5_PYTHON=.venv\Scripts\python.exe"
if not defined KOSPI5_PYTHON set "KOSPI5_PYTHON=python"
if not exist outputs\logs mkdir outputs\logs
"%KOSPI5_PYTHON%" -B run_automation.py --scheduled --write --wait-minutes 90 %* >> "outputs\logs\%1.log" 2>&1
exit /b %errorlevel%
