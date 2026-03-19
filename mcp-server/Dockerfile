FROM python:3.11-slim
WORKDIR /app

# Upgrade build tools to patched versions before installing dependencies
RUN pip install --no-cache-dir "wheel>=0.46.2" "pip>=25.3"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Remove build tools from the final image — not needed at runtime
RUN pip uninstall -y wheel pip setuptools

COPY server.py .
CMD ["python", "server.py"]