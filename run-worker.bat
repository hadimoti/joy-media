@echo off
setlocal
REM Set Joy Media Worker environment variables
set JOY_MEDIA_API_URL=https://media.joyteam.ir/api
set JOY_MEDIA_LOCAL_COMFY_URL=http://127.0.0.1:8188
set JOY_MEDIA_LOCAL_ML_DENOISE=1
set JOY_MEDIA_RNNOISE_MODEL=%USERPROFILE%\rnnoise\model.rnnn
REM Run the worker
node apps\worker\dist\index.js
endlocal