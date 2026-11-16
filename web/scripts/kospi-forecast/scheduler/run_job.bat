@echo off
rem Windows (laptop) wrapper for Task Scheduler: run_job.bat t1|t2|evening
rem Runs: python run_automation.py <job> --write   (mode from service\.env KOSPI_MLOPS_MODE)
cd /d "%~dp0.."
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
if not exist mlops\cache\logs mkdir mlops\cache\logs
python run_automation.py %1 --write >> mlops\cache\logs\%1.log 2>&1
