@echo off
setlocal
REM Set Joy Media Worker environment variables
set "JOY_MEDIA_WORKER_ROOT=%~dp0"
set "JOY_MEDIA_API_URL=https://media.joyteam.ir/api"
set "JOY_MEDIA_LOCAL_COMFY_URL=http://127.0.0.1:8188"
set "JOY_MEDIA_LOCAL_ML_DENOISE=1"
set "JOY_MEDIA_MODEL_ROOT=%USERPROFILE%\JOY\models"
set "JOY_MEDIA_RNNOISE_MODEL=%JOY_MEDIA_MODEL_ROOT%\audio\rnnoise\mp.rnnn"
set "JOY_MEDIA_DEEPFILTERNET_BINARY=%JOY_MEDIA_MODEL_ROOT%\audio\deepfilternet\deep-filter-0.5.6-x86_64-pc-windows-msvc.exe"
set "JOY_MEDIA_ML_DENOISE_CMD=node %JOY_MEDIA_WORKER_ROOT%apps\worker\audio\joy_deepfilternet_runner.mjs"
set "JOY_MEDIA_REAL_ESRGAN_MODEL=%JOY_MEDIA_MODEL_ROOT%\upscaling\RealESRGAN_x4plus.pth"
set "JOY_MEDIA_UPSCALE_IMAGE_PYTHON=%USERPROFILE%\.joy-media\upscaling-venv\Scripts\python.exe"
set "JOY_MEDIA_UPSCALE_IMAGE_RUNNER=%JOY_MEDIA_WORKER_ROOT%apps\worker\upscaling\joy_realesrgan_runner.py"
set "JOY_MEDIA_UPSCALE_IMAGE_MODEL=realesrgan-x4plus"
set "JOY_MEDIA_UPSCALE_IMAGE_MODEL_VERSION=x4plus-local"
set "JOY_MEDIA_MASKING_PYTHON=%USERPROFILE%\.joy-media\upscaling-venv\Scripts\python.exe"
set "JOY_MEDIA_MASKING_RUNNER=%JOY_MEDIA_WORKER_ROOT%apps\worker\masking\joy_masking_router.py"
set "JOY_MEDIA_MASKING_CAPABILITIES=image,video"
set "JOY_MEDIA_BIREFNET_MODEL_DIR=%JOY_MEDIA_MODEL_ROOT%\masking\birefnet"
set "U2NET_HOME=%JOY_MEDIA_BIREFNET_MODEL_DIR%"
set "JOY_MEDIA_SAM2_MODEL=%JOY_MEDIA_MODEL_ROOT%\masking\sam2.1-hiera-large"
set "JOY_MEDIA_GROUNDING_MODEL=%JOY_MEDIA_MODEL_ROOT%\masking\grounding-dino-tiny"
set "JOY_MEDIA_SAM2_RUNTIME_READY=1"
REM Run the worker
node apps\worker\dist\index.js
endlocal
