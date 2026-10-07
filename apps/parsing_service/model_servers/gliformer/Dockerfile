# Supply an ARM64 CUDA/PyTorch base on Spark; no dependencies enter the parsing worker.
ARG GLIFORMER_BASE_IMAGE=vllm/vllm-openai@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90
FROM ${GLIFORMER_BASE_IMAGE}
WORKDIR /service
COPY apps/parsing_service/model_servers/gliformer/requirements.txt .
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY apps/parsing_service/model_servers/gliformer/server.py .
ENTRYPOINT ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
